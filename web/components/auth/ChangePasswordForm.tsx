"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, clearSession, errText } from "@/lib/api";
import PasswordInput from "@/components/ui/PasswordInput";
import st from "./ChangePasswordForm.module.css";

export interface ChangePasswordFormProps {
  required: boolean;
  onClose?: () => void;
  onSuccess?: () => void;
  showCancel?: boolean;
  onBusyChange?: (busy: boolean) => void;
  closeLabel?: string;
}

export default function ChangePasswordForm({
  required,
  onClose,
  onSuccess,
  showCancel = true,
  onBusyChange,
  closeLabel = "取消",
}: ChangePasswordFormProps) {
  const router = useRouter();
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setErr("");
    if (!oldPwd || !newPwd) return setErr("原密码与新密码不能为空");
    if (newPwd.length < 8) return setErr("新密码至少 8 位");
    if (!/[A-Za-z]/.test(newPwd) || !/\d/.test(newPwd)) return setErr("新密码需同时包含字母与数字");
    if (newPwd !== confirm) return setErr("两次输入的新密码不一致");
    setLoading(true);
    onBusyChange?.(true);
    try {
      await authApi.changePassword(oldPwd, newPwd);
      if (required) {
        router.push("/dashboard");
      } else if (onSuccess) {
        onSuccess();
      } else {
        router.push("/dashboard");
      }
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setLoading(false);
      onBusyChange?.(false);
    }
  }

  return (
    <form className={st.form} onSubmit={onSubmit}>
      <p className={st.intro}>
        {required ? "请先设置新密码，再进入工作台。" : "更新你的登录密码，保护账号安全。"}
      </p>
      <div className={st.field}>
        <label htmlFor="old-password">原密码</label>
        <PasswordInput id="old-password" value={oldPwd} onChange={setOldPwd} placeholder="请输入原密码" autoComplete="current-password" disabled={loading} />
      </div>
      <div className={st.field}>
        <label htmlFor="new-password">新密码</label>
        <PasswordInput id="new-password" value={newPwd} onChange={setNewPwd} placeholder="至少 8 位，含字母与数字" autoComplete="new-password" disabled={loading} />
      </div>
      <div className={st.field}>
        <label htmlFor="confirm-password">确认新密码</label>
        <PasswordInput id="confirm-password" value={confirm} onChange={setConfirm} placeholder="再次输入新密码" autoComplete="new-password" disabled={loading} />
      </div>
      {err && <div className="err-banner" role="alert">{err}</div>}
      <button className={`btn-primary ${st.submit}`} type="submit" disabled={loading}>
        {loading ? "提交中…" : "确认修改"}
      </button>
      {required && (
        <button type="button" className="linklike" onClick={() => { clearSession(); router.push("/login"); }} disabled={loading}>
          退出登录
        </button>
      )}
      {!required && onClose && showCancel && (
        <button type="button" className="btn-ghost" onClick={onClose} disabled={loading}>
          {closeLabel}
        </button>
      )}
    </form>
  );
}
