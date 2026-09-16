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
    // 空值前端拦截（PLAN Stage 0 验收）
    if (!username.trim() || !password) {
      setFieldErr("账号和密码不能为空");
      return;
    }
    setFieldErr("");
    setLoading(true);
    try {
      const data = await authApi.login(username.trim(), password);
      saveSession(data.access_token, data.refresh_token);
      // 首次登录强制改密（seed admin 默认 must_change_pwd=true）
      router.push(data.must_change_pwd ? "/change-password" : "/dashboard");
    } catch (err: unknown) {
      setApiErr(errText(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={st.wrap}>
      <div className={st.card}>
        <div className={st.brand}>
          <span className={st.dot} />
          <span className={st.name}>项目管理工作区</span>
        </div>
        <p className={st.sub}>效率控制台 · 请登录后继续</p>
        <form onSubmit={onSubmit}>
          <div className={st.field}>
            <label>账号<input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入账号"
              autoComplete="username"
            /></label>
          </div>
          <div className={st.field}>
            <label>密码<input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
            /></label>
          </div>
          {fieldErr && <div className={`${st.alert} ${st.alertErr}`} role="alert">{fieldErr}</div>}
          {apiErr && <div className={`${st.alert} ${st.alertErr}`} role="alert">{apiErr}</div>}
          <div className={st.submit}>
            <button className="btn-primary" type="submit" disabled={loading}>
              {loading ? "登录中…" : "登 录"}
            </button>
          </div>
        </form>
        <div className={st.hint}>回车直接登录 · 初始账号 <span className="mono">admin / admin123456</span>（首次登录需改密）</div>
      </div>
    </main>
  );
}
