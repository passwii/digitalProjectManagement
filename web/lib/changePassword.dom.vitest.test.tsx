// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  me: { must_change_pwd: false },
  meError: null as unknown,
  meRequest: null as null | (() => Promise<{ must_change_pwd: boolean }>),
  push: vi.fn(),
  back: vi.fn(),
  changePassword: vi.fn(() => Promise.resolve({ ok: true })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
}));

vi.mock("@/lib/useMeta", () => ({
  loadMe: () => mocks.meRequest?.() ?? Promise.resolve(mocks.me),
}));

vi.mock("@/lib/api", () => ({
  authApi: {
    changePassword: mocks.changePassword,
    me: () => mocks.meError ? Promise.reject(mocks.meError) : Promise.resolve(mocks.me),
  },
  clearSession: vi.fn(),
  errText: (error: unknown) => String(error),
}));

import ChangePasswordPage from "../app/change-password/page";
import ChangePasswordDialog from "../app/(dashboard)/@modal/(.)change-password/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.me = { must_change_pwd: false };
  mocks.meError = null;
  mocks.meRequest = null;
  mocks.changePassword.mockResolvedValue({ ok: true });
});

describe("修改密码场景", () => {
  it("普通用户改密文案不再误标为首次登录", async () => {
    render(<ChangePasswordPage />);

    expect(await screen.findByRole("heading", { name: "修改密码" })).toBeTruthy();
    expect(screen.queryByText("首次登录 · 修改密码")).toBeNull();
    expect(screen.queryByRole("button", { name: "返回工作台" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("身份加载期间使用中性状态，确认后再显示准确文案", async () => {
    let resolve!: (value: { must_change_pwd: boolean }) => void;
    mocks.meRequest = () => new Promise((done) => { resolve = done; });
    render(<ChangePasswordPage />);

    expect(screen.getByRole("status").textContent).toContain("正在确认账号状态");
    expect(screen.queryByRole("heading")).toBeNull();
    await act(async () => resolve({ must_change_pwd: false }));
    expect(await screen.findByRole("heading", { name: "修改密码" })).toBeTruthy();
  });

  it("服务端标记首次改密时保留强制提示和退出登录恢复入口", async () => {
    mocks.me = { must_change_pwd: true };
    render(<ChangePasswordPage />);

    expect(await screen.findByRole("heading", { name: "首次登录 · 修改密码" })).toBeTruthy();
    expect(screen.getByText("请先设置新密码，再进入工作台。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });


  it("首次强制改密成功后进入工作台", async () => {
    mocks.me = { must_change_pwd: true };
    render(<ChangePasswordPage />);
    await screen.findByRole("heading", { name: "首次登录 · 修改密码" });

    fireEvent.change(screen.getByLabelText("原密码"), { target: { value: "InitPass123" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "NewPass123" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "NewPass123" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认修改" })));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/dashboard"));
    expect(mocks.changePassword).toHaveBeenCalledWith("InitPass123", "NewPass123");
  });

  it("身份确认失败时提供可恢复的返回登录动作", async () => {
    mocks.meError = new Error("会话已过期");
    mocks.meRequest = () => Promise.reject(mocks.meError);
    render(<ChangePasswordPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("无法确认账号状态：Error: 会话已过期");
    expect(screen.getByRole("button", { name: "返回登录" })).toBeTruthy();
  });

  it("普通改密 Dialog 可关闭并返回原页面", async () => {
    render(<ChangePasswordDialog />);

    expect(await screen.findByRole("dialog", { name: "修改密码" })).toBeTruthy();
    expect(screen.queryByText("首次登录 · 修改密码")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(mocks.back).toHaveBeenCalledOnce();
  });

  it("普通改密成功后调用现有接口并返回来源页面", async () => {
    render(<ChangePasswordDialog />);
    await screen.findByRole("dialog", { name: "修改密码" });

    fireEvent.change(screen.getByLabelText("原密码"), { target: { value: "OldPass123" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "NewPass123" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "NewPass123" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认修改" })));

    await waitFor(() => expect(mocks.back).toHaveBeenCalledOnce());
    expect(mocks.changePassword).toHaveBeenCalledWith("OldPass123", "NewPass123");
  });

  it("提交过程中关闭按钮不会离开 Dialog", async () => {
    let finish!: (value: { ok: boolean }) => void;
    mocks.changePassword.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ChangePasswordDialog />);
    await screen.findByRole("dialog", { name: "修改密码" });

    fireEvent.change(screen.getByLabelText("原密码"), { target: { value: "OldPass123" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "NewPass123" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "NewPass123" } });
    fireEvent.click(screen.getByRole("button", { name: "确认修改" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(mocks.back).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "提交中…" }).hasAttribute("disabled")).toBe(true);
    await act(async () => finish({ ok: true }));
    await waitFor(() => expect(mocks.back).toHaveBeenCalledOnce());
  });
});
