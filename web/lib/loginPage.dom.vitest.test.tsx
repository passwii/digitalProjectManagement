// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  push: vi.fn(),
  saveSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/lib/api", () => ({
  authApi: { login: (...args: unknown[]) => mocks.login(...args) },
  errText: (error: unknown) => error instanceof Error ? error.message : String(error),
  saveSession: (...args: unknown[]) => mocks.saveSession(...args),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { UnauthorizedError } from "@/lib/api";
import LoginPage from "../app/login/page";

beforeEach(() => {
  mocks.login.mockReset();
  mocks.push.mockReset();
  mocks.saveSession.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function enterCredentials(phone = "13800138000", password = "secret") {
  fireEvent.change(screen.getByLabelText("手机号"), { target: { value: phone } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: password } });
  fireEvent.submit(screen.getByLabelText("手机号").closest("form")!);
}

describe("LoginPage", () => {
  it("renders the confirmed glass-card copy, anchors and login controls", () => {
    render(<LoginPage />);

    expect(screen.getByRole("heading", { name: /复杂有章\s+交付有信/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "欢迎回来" })).toBeTruthy();
    expect(screen.getByText("登录后继续你的工作台。")).toBeTruthy();
    expect(screen.getByText("统一台账")).toBeTruthy();
    expect(screen.getByText("进度留痕")).toBeTruthy();
    expect(screen.getByText("支出归集")).toBeTruthy();
    expect(screen.getByText(/仅限授权成员使用/)).toBeTruthy();

    const pageText = document.querySelector("[data-login-page]")!.textContent ?? "";
    for (const removedCopy of [
      "项目协同 · 交付管理",
      "节点 07",
      "数字化项目运营",
      "把台账、进度、成本与审批，收束进同一条可追溯的工作链路",
      "认证入口 / 01",
      "本地节点 / 就绪",
      "数科云办公 // 项目运营",
      "©2026",
      "链路图 / 项目交付",
      "登录管理工作台",
      "会话 / 请重试",
      "会话 / 握手中",
      "会话 / 已验证",
      "会话 / 待命",
      "建立身份链路，进入项目运营空间",
      "项目、进度、支出与审批，在同一个工作空间里保持同一条时间线。",
    ]) {
      expect(pageText).not.toContain(removedCopy);
    }
    expect(pageText).not.toContain("复杂有章，");
    expect(pageText).not.toContain("交付有信。");

    // 不新增后端不存在的登录方式与找回入口
    for (const unsupported of ["短信登录", "扫码登录", "第三方登录", "忘记密码", "微信登录"]) {
      expect(pageText).not.toContain(unsupported);
    }

    expect(screen.getByLabelText("手机号")).toBeTruthy();
    expect(screen.getByLabelText("密码")).toBeTruthy();
    expect(screen.getByRole("button", { name: "进入工作台" })).toBeTruthy();

    // 测试锚点对后续移动端/主题联调保持稳定
    expect(document.querySelector('[data-login="brand"]')).not.toBeNull();
    expect(document.querySelector('[data-login="card"]')).not.toBeNull();
    expect(document.querySelector('[data-auth-state="ready"]')).not.toBeNull();
  });

  it("validates an 11-digit phone and a required password with accessible errors", () => {
    render(<LoginPage />);

    fireEvent.submit(screen.getByLabelText("手机号").closest("form")!);
    const phoneAlert = screen.getByRole("alert");
    expect(phoneAlert.textContent).toContain("请输入 11 位手机号账号");
    expect(screen.getByLabelText("手机号").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("手机号").getAttribute("aria-describedby")).toBe("login-error");
    expect(mocks.login).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.submit(screen.getByLabelText("手机号").closest("form")!);

    expect(screen.getByRole("alert").textContent).toContain("请输入密码");
    expect(screen.getByLabelText("密码").getAttribute("aria-invalid")).toBe("true");
    expect(mocks.login).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("filters non-digits and caps the phone value at 11 characters", () => {
    render(<LoginPage />);
    const phone = screen.getByLabelText("手机号") as HTMLInputElement;

    fireEvent.change(phone, { target: { value: "138abc0013800099" } });
    expect(phone.value).toBe("13800138000");
  });

  it("toggles password visibility with an accessible button", () => {
    render(<LoginPage />);
    const password = screen.getByLabelText("密码") as HTMLInputElement;

    expect(password.type).toBe("password");
    const show = screen.getByRole("button", { name: "显示密码" });
    expect(show.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(show);
    expect(password.type).toBe("text");
    expect(screen.getByRole("button", { name: "隐藏密码" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
    expect(password.type).toBe("password");
  });

  it("shows an accessible identity-verification state while login is pending", async () => {
    let resolveLogin!: (value: {
      access_token: string;
      refresh_token: string;
      must_change_pwd: boolean;
    }) => void;
    mocks.login.mockImplementation(
      () => new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );

    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    const idleButton = screen.getByRole("button", { name: "进入工作台" });
    expect(idleButton.getAttribute("aria-busy")).toBe("false");
    fireEvent.submit(screen.getByLabelText("手机号").closest("form")!);

    const button = await screen.findByRole("button", { name: "正在验证身份…" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("[data-auth-state]")?.getAttribute("data-auth-state")).toBe("loading");
    const loadingStatus = screen.getByRole("status");
    expect(loadingStatus.textContent).toBe("正在验证身份…");
    expect(loadingStatus.closest("button")).toBeNull();

    resolveLogin({ access_token: "access", refresh_token: "refresh", must_change_pwd: false });
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/dashboard"));
  });

  it("keeps a fast login visible, then shows success before navigating", async () => {
    vi.useFakeTimers();
    mocks.login.mockResolvedValue({
      access_token: "access",
      refresh_token: "refresh",
      must_change_pwd: false,
    });

    render(<LoginPage />);
    await act(async () => {
      enterCredentials();
      await Promise.resolve();
    });

    const loadingButton = screen.getByRole("button", { name: "正在验证身份…" });
    expect(loadingButton.getAttribute("aria-busy")).toBe("true");
    expect(mocks.push).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(219);
    });
    expect(screen.getByRole("button", { name: "正在验证身份…" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const successButton = screen.getByRole("button", { name: "登录成功，正在跳转…" });
    expect(successButton.getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector("[data-auth-state]")?.getAttribute("data-auth-state")).toBe("redirecting");
    const successStatus = screen.getByRole("status");
    expect(successStatus.textContent).toBe("登录成功，正在跳转…");
    expect(successStatus.closest("button")).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(mocks.push).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.push).toHaveBeenCalledWith("/dashboard");
  });

  it("holds the verification state for slow responses and still shows success before navigating", async () => {
    vi.useFakeTimers();
    let resolveLogin!: (value: {
      access_token: string;
      refresh_token: string;
      must_change_pwd: boolean;
    }) => void;
    mocks.login.mockImplementation(
      () => new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );

    render(<LoginPage />);
    await act(async () => {
      enterCredentials();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(screen.getByRole("button", { name: "正在验证身份…" })).toBeTruthy();
    expect(mocks.push).not.toHaveBeenCalled();

    await act(async () => {
      resolveLogin({ access_token: "access", refresh_token: "refresh", must_change_pwd: true });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "登录成功，正在跳转…" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(mocks.push).toHaveBeenCalledWith("/change-password");
  });

  it("returns an enabled idle button immediately when authentication fails", async () => {
    mocks.login.mockRejectedValue(new Error("network unavailable"));

    render(<LoginPage />);
    await act(async () => {
      enterCredentials();
      await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("network unavailable");
    expect(document.querySelector("[data-auth-state]")?.getAttribute("data-auth-state")).toBe("error");
    const button = screen.getByRole("button", { name: "进入工作台" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps the friendly credential message for UnauthorizedError", async () => {
    mocks.login.mockRejectedValue(new UnauthorizedError());

    render(<LoginPage />);
    await act(async () => {
      enterCredentials();
      await Promise.resolve();
    });

    expect((await screen.findByRole("alert")).textContent).toContain("手机号或密码错误");
    expect(screen.getByRole("button", { name: "进入工作台" }).hasAttribute("disabled")).toBe(false);
  });

  it("writes the real session before navigating", async () => {
    vi.useFakeTimers();
    mocks.login.mockResolvedValue({
      access_token: "access-token",
      refresh_token: "refresh-token",
      must_change_pwd: false,
    });

    render(<LoginPage />);
    await act(async () => {
      enterCredentials();
      await Promise.resolve();
    });
    expect(mocks.saveSession).toHaveBeenCalledWith("access-token", "refresh-token");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(370);
    });
    expect(mocks.push).toHaveBeenCalledWith("/dashboard");
  });
});
