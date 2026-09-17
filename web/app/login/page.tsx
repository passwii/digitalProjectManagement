"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, errText, saveSession } from "@/lib/api";
import MobileAuthShell from "@/components/auth/MobileAuthShell";
import PasswordInput from "@/components/auth/PasswordInput";
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
    <MobileAuthShell
      title="登录工作区"
      subtitle="使用项目管理系统账号继续"
      footer={
        <>
          首次登录需要修改密码
          {process.env.NODE_ENV !== "production" ? (
            <>
              {" · 初始账号 "}
              <span className="mono">admin / admin123456</span>
            </>
          ) : null}
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <div className={st.field}>
          <label htmlFor="username">账号</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入账号"
            autoComplete="username"
            enterKeyHint="next"
            disabled={loading}
          />
        </div>
        <PasswordInput
          label="密码"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={loading}
        />
        {fieldErr ? <div className={st.alert} role="alert">{fieldErr}</div> : null}
        {apiErr ? <div className={st.alert} role="alert">{apiErr}</div> : null}
        <div className={st.submit}>
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? "登录中…" : "登 录"}
          </button>
        </div>
      </form>
    </MobileAuthShell>
  );
}
