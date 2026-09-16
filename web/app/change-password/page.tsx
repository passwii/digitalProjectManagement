"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, clearSession, errText } from "@/lib/api";
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
    <main className={st.wrap}>
      <div className={st.card}>
        <div className={st.brand}>
          <span className={st.dot} />
          <span className={st.name}>首次登录 · 修改密码</span>
        </div>
        <p className={st.sub}>为保障账号安全，请设置新密码后继续</p>
        <form onSubmit={onSubmit}>
          <div className={st.field}>
            <label>原密码<input type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} placeholder="请输入原密码" autoComplete="current-password" /></label>
          </div>
          <div className={st.field}>
            <label>新密码<input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder="至少 8 位，含字母与数字" autoComplete="new-password" /></label>
          </div>
          <div className={st.field}>
            <label>确认新密码<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入新密码" autoComplete="new-password" /></label>
          </div>
          {err && <div className={`${st.alert} ${st.alertErr}`} role="alert">{err}</div>}
          <div className={st.submit}>
            <button className="btn-primary" type="submit" disabled={loading}>
              {loading ? "提交中…" : "确认修改"}
            </button>
          </div>
        </form>
        <div className={st.hint}>
          <button type="button" className="linklike" onClick={() => { clearSession(); router.push("/login"); }}>
            退出登录
          </button>
        </div>
      </div>
    </main>
  );
}
