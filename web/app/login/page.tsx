"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authApi, errText, saveSession, UnauthorizedError } from "@/lib/api";
import st from "./login.module.css";

/** 提交后至少让「正在验证身份」可见，避免接口过快时反馈一闪而过。 */
const MIN_LOADING_MS = 220;
/** 成功态停留时长；随后才真正跳转，给用户一个明确的完成信号。 */
const SUCCESS_FEEDBACK_MS = 150;

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

type FieldName = "phone" | "password";

interface LoginError {
  message: string;
  field: FieldName | null;
}

const CLEAR_ERROR: LoginError = { message: "", field: null };

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<LoginError>(CLEAR_ERROR);
  const [submitPhase, setSubmitPhase] = useState<"idle" | "loading" | "success">("idle");
  const phoneRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const busy = submitPhase !== "idle";
  const authState =
    submitPhase === "loading"
      ? "loading"
      : submitPhase === "success"
        ? "redirecting"
        : error.message
          ? "error"
          : "ready";
  const submitLabel =
    submitPhase === "loading"
      ? "正在验证身份…"
      : submitPhase === "success"
        ? "登录成功，正在跳转…"
        : "进入工作台";

  function clearError() {
    if (error.message) setError(CLEAR_ERROR);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    setError(CLEAR_ERROR);
    const phone = username.trim();
    if (!/^1\d{10}$/.test(phone)) {
      setError({ message: "请输入 11 位手机号账号", field: "phone" });
      phoneRef.current?.focus();
      return;
    }
    if (!password) {
      setError({ message: "请输入密码", field: "password" });
      passwordRef.current?.focus();
      return;
    }

    const submittedAt = Date.now();
    setSubmitPhase("loading");
    try {
      const data = await authApi.login(phone, password);
      saveSession(data.access_token, data.refresh_token);
      const loadingRemaining = MIN_LOADING_MS - (Date.now() - submittedAt);
      if (loadingRemaining > 0) await wait(loadingRemaining);
      setSubmitPhase("success");
      await wait(SUCCESS_FEEDBACK_MS);
      router.push(data.must_change_pwd ? "/change-password" : "/dashboard");
    } catch (err: unknown) {
      setSubmitPhase("idle");
      setError({
        message:
          err instanceof UnauthorizedError
            ? "手机号或密码错误"
            : errText(err),
        field: null,
      });
    }
  }

  return (
    <div className={st.wrap} data-login-page>
      <div className={st.ambient} aria-hidden="true">
        <span className={`${st.blob} ${st.blobA}`} />
        <span className={`${st.blob} ${st.blobB}`} />
      </div>

      <div className={st.stage}>
        <main className={st.authCard} data-login="card">
          <section className={st.story} data-login="brand" aria-label="数科云办公">
            <div className={st.storyGrid} aria-hidden="true" />
            <div className={st.brand}>
              <span className={st.brandGlyph} aria-hidden="true">
                <b>SHZK</b>
                <i />
              </span>
              <span className={st.brandText}>
                <b>数科云办公</b>
                <span>DIGITAL DELIVERY</span>
              </span>
            </div>

            <div className={st.storyCopy}>
              <p className={st.eyebrow}>PROJECT OPERATING SYSTEM</p>
              <h1>
                复杂有章 <span>交付有信</span>
              </h1>
              <p className={st.lede}>项目、进度、支出与审批，在同一个工作空间里保持同一条时间线。</p>
            </div>

            <ol className={st.steps} aria-label="工作方式">
              <li>
                <b>01</b>统一台账<i aria-hidden="true" />
              </li>
              <li>
                <b>02</b>进度留痕<i aria-hidden="true" />
              </li>
              <li>
                <b>03</b>支出归集
              </li>
            </ol>
          </section>

          <section className={st.auth} data-auth-state={authState} aria-labelledby="login-title">
            <div className={st.formPanel}>
              <div className={st.formHead}>
                <span className={`${st.brandGlyph} ${st.miniSeal}`} aria-hidden="true">
                  <b>SHZK</b>
                  <i />
                </span>
                <div>
                  <p className={st.kicker}>WELCOME BACK</p>
                  <h2 className={st.title} id="login-title">
                    欢迎回来
                  </h2>
                  <p className={st.subtitle}>登录后继续你的工作台。</p>
                </div>
              </div>

              <form onSubmit={onSubmit} noValidate>
                <div className={st.field}>
                  <label htmlFor="login-phone">手机号</label>
                  <div className={st.control}>
                    <input
                      ref={phoneRef}
                      id="login-phone"
                      name="phone"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="username"
                      maxLength={11}
                      value={username}
                      placeholder="请输入 11 位手机号"
                      disabled={busy}
                      aria-invalid={error.field === "phone" ? true : undefined}
                      aria-describedby={error.message ? "login-error" : undefined}
                      onChange={(e) => {
                        clearError();
                        setUsername(e.target.value.replace(/\D/g, "").slice(0, 11));
                      }}
                    />
                  </div>
                </div>

                <div className={st.field}>
                  <label htmlFor="login-password">密码</label>
                  <div className={`${st.control} ${st.passwordControl}`}>
                    <input
                      ref={passwordRef}
                      id="login-password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      value={password}
                      placeholder="请输入登录密码"
                      disabled={busy}
                      aria-invalid={error.field === "password" ? true : undefined}
                      aria-describedby={error.message ? "login-error" : undefined}
                      onChange={(e) => {
                        clearError();
                        setPassword(e.target.value);
                      }}
                    />
                    <button
                      type="button"
                      className={st.eye}
                      onClick={() => setShowPassword((visible) => !visible)}
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                      aria-pressed={showPassword}
                      disabled={busy}
                    >
                      {showPassword ? (
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M3 3l18 18" />
                          <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
                          <path d="M9.9 4.2A10.4 10.4 0 0 1 12 4c5.5 0 9 6 9 8a10.5 10.5 0 0 1-2.2 3.3" />
                          <path d="M6.3 6.3A11.8 11.8 0 0 0 3 12c0 2 3.5 8 9 8a9.8 9.8 0 0 0 4.2-.9" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                          <circle cx="12" cy="12" r="2.6" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {error.message && (
                  <div className={st.alert} id="login-error" role="alert">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v6M12 17h.01" />
                    </svg>
                    <span>{error.message}</span>
                  </div>
                )}

                <button
                  className={st.submit}
                  type="submit"
                  disabled={busy}
                  aria-busy={submitPhase === "loading"}
                  data-phase={submitPhase}
                >
                  <span className={st.submitLabel}>{submitLabel}</span>
                  <span className={st.submitArrow} aria-hidden="true">
                    {submitPhase === "loading" ? (
                      <span className={st.submitSpinner} />
                    ) : submitPhase === "success" ? (
                      <svg className={st.submitCheck} viewBox="0 0 16 16" fill="none">
                        <path d="m3.5 8.5 3 3 6-7" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="none">
                        <path d="M3 13 13 3M6 3h7v7" />
                      </svg>
                    )}
                  </span>
                </button>

                <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                  {busy ? submitLabel : ""}
                </span>
              </form>

              <p className={st.formFoot}>
                仅限授权成员使用<span> · </span>遇到问题请联系系统管理员
              </p>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
