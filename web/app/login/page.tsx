"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, errText, saveSession } from "@/lib/api";
import st from "./login.module.css";

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
      setApiErr(errText(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={st.wrap}>
      <section className={st.story}>
        <div className={st.storyGrid} aria-hidden />
        <div className={st.storyTop}>
          <span className={st.mark}>数慧致科</span>
          <span className={st.edition}>OA / PROJECT DELIVERY</span>
        </div>
        <div className={st.storyMain}>
          <p className={st.kicker}>Digital Project Operations</p>
          <h1>
            数慧致科
            <span>OA管理平台</span>
          </h1>
          <p className={st.storyText}>
            让项目台账、交付进度、合同档案与支出记录沉淀在同一套管理坐标中。
          </p>
        </div>
        <div className={st.storyFoot}>
          <div><b>01</b><span>统一台账</span></div>
          <div><b>02</b><span>进度留痕</span></div>
          <div><b>03</b><span>支出归集</span></div>
        </div>
      </section>

      <section className={st.auth}>
        <div className={st.card}>
          <div className={st.cardHead}>
            <span className={st.cardBadge}>SHZK</span>
            <div>
              <p className={st.cardEyebrow}>数慧致科OA管理平台</p>
              <h2>登录管理工作台</h2>
            </div>
          </div>
          <p className={st.sub}>使用管理员签发的手机号账号登录。</p>
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
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入登录密码"
                autoComplete="current-password"
              />
            </div>
            {fieldErr && <div className={`${st.alert} ${st.alertErr}`} role="alert">{fieldErr}</div>}
            {apiErr && <div className={`${st.alert} ${st.alertErr}`} role="alert">{apiErr}</div>}
            <button className={st.submit} type="submit" disabled={loading}>
              {loading ? "正在验证…" : "进入管理平台"}
            </button>
          </form>
          <div className={st.hint}>
            <span>初始管理员</span>
            <b className="mono">15796280534</b>
            <span>首次登录须修改密码</span>
          </div>
        </div>
        <p className={st.copyright}>数慧致科 · 项目管理系统</p>
      </section>
    </main>
  );
}
