"use client";

import { useRef, useState } from "react";
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
  const [oldPwdErr, setOldPwdErr] = useState("");
  const [newPwdErr, setNewPwdErr] = useState("");
  const [confirmErr, setConfirmErr] = useState("");
  const [apiErr, setApiErr] = useState("");
  const [loading, setLoading] = useState(false);
  const oldPwdRef = useRef<HTMLInputElement>(null);
  const newPwdRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApiErr("");

    const nextOldPwdErr = oldPwd ? "" : "请输入原密码";
    let nextNewPwdErr = "";
    if (!newPwd) nextNewPwdErr = "请输入新密码";
    else if (newPwd.length < 8) nextNewPwdErr = "新密码至少 8 位";
    else if (!/[A-Za-z]/.test(newPwd) || !/\d/.test(newPwd)) {
      nextNewPwdErr = "新密码需同时包含字母与数字";
    }
    const nextConfirmErr = newPwd === confirm ? "" : "两次输入的新密码不一致";

    setOldPwdErr(nextOldPwdErr);
    setNewPwdErr(nextNewPwdErr);
    setConfirmErr(nextConfirmErr);
    if (nextOldPwdErr || nextNewPwdErr || nextConfirmErr) {
      if (nextOldPwdErr) oldPwdRef.current?.focus();
      else if (nextNewPwdErr) newPwdRef.current?.focus();
      else confirmRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      await authApi.changePassword(oldPwd, newPwd);
      router.push("/dashboard");
    } catch (e2) {
      setApiErr(errText(e2));
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
          onClick={async () => {
            await clearSession();
          }}
        >
          退出登录
        </button>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <PasswordInput
          ref={oldPwdRef}
          label="原密码"
          value={oldPwd}
          onChange={(value) => {
            setOldPwd(value);
            if (oldPwdErr) setOldPwdErr("");
          }}
          autoComplete="current-password"
          enterKeyHint="next"
          error={oldPwdErr || undefined}
          disabled={loading}
        />
        <PasswordInput
          ref={newPwdRef}
          label="新密码"
          value={newPwd}
          onChange={(value) => {
            setNewPwd(value);
            if (newPwdErr) setNewPwdErr("");
            if (confirmErr) setConfirmErr("");
          }}
          autoComplete="new-password"
          enterKeyHint="next"
          error={newPwdErr || undefined}
          hint="至少 8 位，同时包含字母与数字"
          disabled={loading}
        />
        <PasswordInput
          ref={confirmRef}
          label="确认新密码"
          value={confirm}
          onChange={(value) => {
            setConfirm(value);
            if (confirmErr) setConfirmErr("");
          }}
          autoComplete="new-password"
          enterKeyHint="done"
          error={confirmErr || undefined}
          disabled={loading}
        />
        {apiErr ? <div className={st.alert} role="alert">{apiErr}</div> : null}
        <div className={st.submit}>
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? "提交中…" : "确认修改"}
          </button>
        </div>
      </form>
    </MobileAuthShell>
  );
}
