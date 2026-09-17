"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, clearSession, errText } from "@/lib/api";
import MobileAuthShell from "@/components/auth/MobileAuthShell";
import PasswordInput from "@/components/auth/PasswordInput";
import st from "../login/login.module.css";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!oldPwd || !newPwd) return setErr("原密码与新密码不能为空");
    if (newPwd.length < 8) return setErr("新密码至少 8 位");
    if (!/[A-Za-z]/.test(newPwd) || !/\d/.test(newPwd)) return setErr("新密码需同时包含字母与数字");
    if (newPwd !== confirm) return setErr("两次输入的新密码不一致");
    setLoading(true);
    try {
      await authApi.changePassword(oldPwd, newPwd);
      router.push("/dashboard");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setLoading(false);
    }
  }

  return (
    <MobileAuthShell
      title="设置新密码"
      subtitle="为保障账号安全，请完成首次改密"
      footer={
        <button
          type="button"
          className="linklike"
          onClick={() => {
            clearSession();
            router.push("/login");
          }}
        >
          退出登录
        </button>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <PasswordInput
          label="原密码"
          value={oldPwd}
          onChange={setOldPwd}
          autoComplete="current-password"
          disabled={loading}
        />
        <PasswordInput
          label="新密码"
          value={newPwd}
          onChange={setNewPwd}
          autoComplete="new-password"
          hint="至少 8 位，同时包含字母与数字"
          disabled={loading}
        />
        <PasswordInput
          label="确认新密码"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          disabled={loading}
        />
        {err ? <div className={st.alert} role="alert">{err}</div> : null}
        <div className={st.submit}>
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? "提交中…" : "确认修改"}
          </button>
        </div>
      </form>
    </MobileAuthShell>
  );
}
