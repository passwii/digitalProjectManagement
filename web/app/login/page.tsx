"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, errText, saveSession } from "@/lib/api";
import MobileAuthShell from "@/components/auth/MobileAuthShell";
import PasswordInput from "@/components/auth/PasswordInput";
import st from "./login.module.css";

const SESSION_NOTICES: Record<string, string> = {
  expired: "会话已过期，请重新登录。",
  logout: "已安全退出登录。",
  logout_failed: "未能确认服务端退出，请联网后重新登录。",
};

function loginNotice(search: string): string {
  const params = new URLSearchParams(search);
  const reason = params.get("reason")
    || (params.get("logged_out") === "1" ? "logout_failed" : "");
  return SESSION_NOTICES[reason] ?? "";
}

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [usernameErr, setUsernameErr] = useState("");
  const [passwordErr, setPasswordErr] = useState("");
  const [apiErr, setApiErr] = useState("");
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNotice(loginNotice(window.location.search));
    const syncNetwork = () => setOnline(navigator.onLine);
    syncNetwork();
    window.addEventListener("online", syncNetwork);
    window.addEventListener("offline", syncNetwork);
    return () => {
      window.removeEventListener("online", syncNetwork);
      window.removeEventListener("offline", syncNetwork);
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApiErr("");
    if (!online) return;

    const nextUsernameErr = username.trim() ? "" : "请输入账号";
    const nextPasswordErr = password ? "" : "请输入密码";
    setUsernameErr(nextUsernameErr);
    setPasswordErr(nextPasswordErr);
    if (nextUsernameErr || nextPasswordErr) {
      if (nextUsernameErr) usernameRef.current?.focus();
      else passwordRef.current?.focus();
      return;
    }

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
        {notice ? (
          <div className={st.notice} role="status">{notice}</div>
        ) : null}
        {!online ? (
          <div className={st.offline} role="status">需要网络连接才能登录，请恢复网络后重试。</div>
        ) : null}
        <div className={st.field}>
          <label htmlFor="username">账号</label>
          <input
            ref={usernameRef}
            id="username"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (usernameErr) setUsernameErr("");
            }}
            placeholder="请输入账号"
            autoComplete="username"
            enterKeyHint="next"
            disabled={loading}
            aria-invalid={Boolean(usernameErr)}
            aria-describedby={usernameErr ? "username-error" : undefined}
          />
          {usernameErr ? (
            <span id="username-error" className="field-err" role="alert">{usernameErr}</span>
          ) : null}
        </div>
        <PasswordInput
          ref={passwordRef}
          label="密码"
          value={password}
          onChange={(value) => {
            setPassword(value);
            if (passwordErr) setPasswordErr("");
          }}
          autoComplete="current-password"
          enterKeyHint="go"
          error={passwordErr || undefined}
          disabled={loading}
        />
        {apiErr ? <div className={st.alert} role="alert">{apiErr}</div> : null}
        <div className={st.submit}>
          <button className="btn-primary" type="submit" disabled={loading || !online}>
            {!online ? "需要联网" : loading ? "登录中…" : "登 录"}
          </button>
        </div>
      </form>
    </MobileAuthShell>
  );
}
