import type { ReactNode } from "react";
import st from "./MobileAuthShell.module.css";

export default function MobileAuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className={st.page}>
      <section className={st.shell} aria-labelledby="auth-title">
        <header className={st.header}>
          <div className={st.brand}>
            <span className={st.dot} aria-hidden="true" />
            <span>项目管理工作区</span>
          </div>
          <h1 id="auth-title">{title}</h1>
          <p>{subtitle}</p>
        </header>
        <div className={st.form}>{children}</div>
        {footer ? <footer className={st.footer}>{footer}</footer> : null}
      </section>
    </main>
  );
}
