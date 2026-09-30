"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clearSession, errText, type Me } from "@/lib/api";
import { loadMe } from "@/lib/useMeta";
import ChangePasswordForm from "@/components/auth/ChangePasswordForm";
import st from "../login/login.module.css";
import formSt from "@/components/auth/ChangePasswordForm.module.css";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    loadMe()
      .then((current) => {
        if (alive) setMe(current);
      })
      .catch((cause: unknown) => {
        if (alive) setError(errText(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!me) {
    return (
      <main className={`${st.wrap} ${st.solo}`}>
        <section className={st.auth}>
          {error ? (
            <div className={formSt.loading}>
              <p role="alert">无法确认账号状态：{error}</p>
              <button type="button" className="btn-ghost" onClick={() => { clearSession(); router.push("/login"); }}>
                返回登录
              </button>
            </div>
          ) : (
            <div className={formSt.loading} role="status">正在确认账号状态…</div>
          )}
        </section>
      </main>
    );
  }

  const required = me.must_change_pwd;

  return (
    <main className={`${st.wrap} ${st.solo}`}>
      <section className={st.auth}>
        <div className={st.card}>
          <div className={st.cardHead}>
            <span className={st.cardBadge} aria-hidden="true">SHZK</span>
            <div>
              <p className={st.cardEyebrow}>数科云办公</p>
              <h1>{required ? "首次登录 · 修改密码" : "修改密码"}</h1>
            </div>
          </div>
          <ChangePasswordForm
            required={required}
            onClose={required ? undefined : () => router.push("/dashboard")}
            onSuccess={required ? undefined : () => router.push("/dashboard")}
            closeLabel="返回工作台"
            showCancel={false}
          />
        </div>
      </section>
    </main>
  );
}
