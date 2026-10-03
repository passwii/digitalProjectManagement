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

function enterCredentials() {
  fireEvent.change(screen.getByLabelText("手机号"), { target: { value: "13800138000" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
  fireEvent.submit(screen.getByLabelText("手机号").closest("form")!);
}

describe("LoginPage CTA", () => {
  it("shows only the retained tagline and keeps the login controls", () => {
    render(<LoginPage />);

    expect(screen.getByRole("heading", { name: /复杂有章\s+交付有信/ })).toBeTruthy();
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
      "登录控制台",
      "会话 / 请重试",
      "会话 / 握手中",
      "会话 / 已验证",
      "会话 / 待命",
      "建立身份链路，进入项目运营空间",
    ]) {
      expect(pageText).not.toContain(removedCopy);
    }
    expect(pageText).not.toContain("复杂有章，");
    expect(pageText).not.toContain("交付有信。");
    expect(screen.getByRole("heading", { name: "登录管理工作台" })).toBeTruthy();
    expect(screen.getByLabelText("手机号")).toBeTruthy();
    expect(screen.getByLabelText("密码")).toBeTruthy();
    expect(screen.getByRole("button", { name: "进入管理平台" })).toBeTruthy();
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
    const idleButton = screen.getByRole("button", { name: "进入管理平台" });
    expect(idleButton.getAttribute("aria-busy")).toBe("false");
    fireEvent.submit(screen.getByLabelText("手机号").closest("form")!);

    const button = await screen.findByRole("button", { name: "正在验证身份…" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
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

  it("returns to an enabled idle button immediately when authentication fails", async () => {
    mocks.login.mockRejectedValue(new Error("network unavailable"));

    render(<LoginPage />);
    await act(async () => {
      enterCredentials();
      await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("network unavailable");
    const button = screen.getByRole("button", { name: "进入管理平台" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
