// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  errText: (error: unknown) => String(error),
  saveSession: (...args: unknown[]) => mocks.saveSession(...args),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import LoginPage from "../app/login/page";

beforeEach(() => {
  mocks.login.mockReset();
  mocks.push.mockReset();
  mocks.saveSession.mockReset();
});

afterEach(() => cleanup());

describe("LoginPage CTA", () => {
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

    resolveLogin({ access_token: "access", refresh_token: "refresh", must_change_pwd: false });
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/dashboard"));
  });
});
