"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, clearSession, errText } from "@/lib/api";
import PasswordInput from "@/components/ui/PasswordInput";
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
    <main className={`${st.wrap} ${st.solo}`}>
      <section className={st.auth}>
        <div className={st.card}>
          <div className={st.cardHead}>
            <span className={st.cardBadge}>SHZK</span>
            <div>
              <p className={st.cardEyebrow}>数科云办公</p>
              <h2>首次登录 · 修改密码</h2>
            </div>
          </div>
          <form onSubmit={onSubmit}>
            <div className={st.field}>
              <label htmlFor="old-password">原密码</label>
              <PasswordInput id="old-password" value={oldPwd} onChange={setOldPwd} placeholder="请输入原密码" autoComplete="current-password" />
            </div>
            <div className={st.field}>
              <label htmlFor="new-password">新密码</label>
              <PasswordInput id="new-password" value={newPwd} onChange={setNewPwd} placeholder="至少 8 位，含字母与数字" autoComplete="new-password" />
            </div>
            <div className={st.field}>
              <label htmlFor="confirm-password">确认新密码</label>
              <PasswordInput id="confirm-password" value={confirm} onChange={setConfirm} placeholder="再次输入新密码" autoComplete="new-password" />
            </div>
            {err && <div className={`${st.alert} ${st.alertErr}`} role="alert">{err}</div>}
            <button className={st.submit} type="submit" disabled={loading}>
              {loading ? "提交中…" : "确认修改"}
            </button>
          </form>
          <div className={st.hint}>
            <button type="button" className="linklike" onClick={() => { clearSession(); router.push("/login"); }}>
              退出登录
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
