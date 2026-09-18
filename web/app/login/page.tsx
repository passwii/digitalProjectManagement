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
        err instanceof UnauthorizedError ? "手机号或密码错误" : errText(err),
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
          <span className={st.mark}>数科云办公</span>
          <span className={st.edition}>OA / PROJECT DELIVERY</span>
        </div>
        <div className={st.storyMain}>
          <p className={st.kicker}>Digital Project Operations</p>
          <h1>数科云办公</h1>
          <p className={st.storyText}>复杂有章，交付有信。</p>
        </div>
        <div className={st.storyFoot}>
          <StorySteps steps={STORY_STEPS} />
        </div>
      </section>

      <section className={st.auth}>
        <div className={st.card} data-login="card">
          <div className={st.cardHead}>
            <span className={st.cardBadge}>SHZK</span>
            <div>
              <p className={st.cardEyebrow}>数科云办公</p>
              <h2>登录管理工作台</h2>
            </div>
          </div>
          <form onSubmit={onSubmit}>
            <div className={st.field}>
              <label htmlFor="login-phone">手机号</label>
              <input
                id="login-phone"
                value={username}
                onChange={(e) =>
                  setUsername(e.target.value.replace(/\D/g, "").slice(0, 11))
                }
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
            {fieldErr && (
              <div className={`${st.alert} ${st.alertErr}`} role="alert">
                {fieldErr}
              </div>
            )}
            {apiErr && (
              <div className={`${st.alert} ${st.alertErr}`} role="alert">
                {apiErr}
              </div>
            )}
            <button className={st.submit} type="submit" disabled={loading}>
              {loading ? "正在验证…" : "进入管理平台"}
            </button>
          </form>
        </div>
        <p className={st.copyright} data-login="hint">
          数科云办公©2026
        </p>
      </section>
    </main>
  );
}
