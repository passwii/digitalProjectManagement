"use client";

import type { ReactNode } from "react";
import s from "./PageHeader.module.css";

export default function PageHeader({
  title,
  filters,
  actions,
  className,
}: {
  title: string;
  filters?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      <header
        className={`${s.pageHeader}${className ? ` ${className}` : ""}`}
        data-page-header="true"
      >
        <div className={s.titleWrap} data-page-header-title="true">
          <span className={s.title}>{title}</span>
        </div>
        {filters && (
          <div className={s.filters} data-page-header-filters="true">
            {filters}
          </div>
        )}
        {actions && (
          <div className={`${s.actions} no-print`} data-page-header-actions="true">
            {actions}
          </div>
        )}
      </header>
    </>
  );
}
