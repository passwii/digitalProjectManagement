"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, errText, saveSession, UnauthorizedError } from "@/lib/api";
import PasswordInput from "@/components/ui/PasswordInput";
import StorySteps from "@/components/motion/StorySteps";
import st from "./login.module.css";

/**
 * 登录页左栏的三段式步骤文案。
 *
 * 顺序即业务顺序（先立台账 → 再留进度 → 后归集支出），动效按此顺序逐条推进；
 * 文案与序号都在这里，动效组件只负责编排节奏（不写死业务词）。
 */
const STORY_STEPS = [
  { no: "01", label: "统一台账" },
  { no: "02", label: "进度留痕" },
  { no: "03", label: "支出归集" },
] as const;

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErr, setFieldErr] = useState("");
  const [apiErr, setApiErr] = useState("");
  const [loading, setLoading] = useState(false);

  const hasError = Boolean(fieldErr || apiErr);
  const authState = loading ? "loading" : hasError ? "error" : "ready";
  const sessionLabel = loading
    ? "会话 / 握手中"
    : hasError
      ? "会话 / 请重试"
      : "会话 / 待命";
  const nodeLabel = loading
    ? "本地节点 / 同步中"
    : hasError
      ? "本地节点 / 待检查"
      : "本地节点 / 就绪";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApiErr("");
    if (!/^1\d{10}$/.test(username.trim())) {
      setFieldErr("请输入 11 位手机号账号");
      return;
    }
    if (!password) {
      setFieldErr("请输入密码");
      return;
    }
    setFieldErr("");
    setLoading(true);
    try {
      const data = await authApi.login(username.trim(), password);
      saveSession(data.access_token, data.refresh_token);
      router.push(data.must_change_pwd ? "/change-password" : "/dashboard");
    } catch (err: unknown) {
      setApiErr(
        err instanceof UnauthorizedError
          ? "手机号或密码错误"
          : errText(err),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={st.wrap}>
      <section className={st.story} data-login="brand">
        <div className={st.storyGrid} aria-hidden />
        <div className={st.storyTop}>
          <div className={st.brandLockup}>
            <span className={st.brandGlyph} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className={st.mark}>数科云办公</span>
          </div>
          <span className={st.edition}>
            <span className={st.editionDot} />
            项目协同 · 交付管理 / 节点 07
          </span>
        </div>
        <div className={st.storyMain}>
          <div className={st.storyCopy}>
            <h1>
              复杂有章，
              <span>交付有信。</span>
            </h1>
            <p className={st.storyText}>
              <strong>数字化项目运营</strong> · 把台账、进度、成本与审批，收束进同一条可追溯的工作链路。
            </p>
          </div>
        </div>
        <div className={st.storyFoot}>
          <StorySteps steps={STORY_STEPS} />
          <span className={st.storyFootMeta}>链路图 / 项目交付</span>
        </div>
      </section>

      <section
        className={st.auth}
        data-auth-state={authState}
      >
        <div className={st.authShell}>
          <div className={st.consoleTop}>
            <span>登录控制台</span>
            <span>{sessionLabel}</span>
          </div>
          <div className={st.card} data-login="card">
            <div className={st.cardHead}>
              <span className={st.cardBadge} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <div>
                <h2>登录管理工作台</h2>
                <p className={st.cardIntro}>建立身份链路，进入项目运营空间</p>
              </div>
            </div>
            <form onSubmit={onSubmit}>
              <div className={st.field}>
                <label htmlFor="login-phone">手机号</label>
                <input
                  id="login-phone"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/\D/g, "").slice(0, 11))}
                  placeholder="请输入 11 位手机号"
                  inputMode="numeric"
                  autoComplete="username"
                />
              </div>
              <div className={st.field}>
                <label htmlFor="login-password">密码</label>
                <PasswordInput
                  id="login-password"
                  value={password}
                  onChange={setPassword}
                  placeholder="请输入登录密码"
                  autoComplete="current-password"
                />
              </div>
              {fieldErr && <div className={`${st.alert} ${st.alertErr}`} role="alert">{fieldErr}</div>}
              {apiErr && <div className={`${st.alert} ${st.alertErr}`} role="alert">{apiErr}</div>}
              <button className={st.submit} type="submit" disabled={loading}>
                <span>{loading ? "正在建立链路…" : "进入管理平台"}</span>
                <span className={st.submitArrow} aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 13 13 3M6 3h7v7" />
                  </svg>
                </span>
              </button>
            </form>
            <div className={st.cardMeta} aria-hidden="true">
              <span>认证入口 / 01</span>
              <span>{nodeLabel}</span>
            </div>
          </div>
          <p className={st.copyright} data-login="hint">
            <span>数科云办公 // 项目运营</span>
            <span>©2026</span>
          </p>
        </div>
      </section>
    </main>
  );
}
