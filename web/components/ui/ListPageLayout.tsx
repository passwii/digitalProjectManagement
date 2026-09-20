"use client";

import type { ReactNode } from "react";
import s from "./ListPageLayout.module.css";

export function ListPageLayout({
  toolbar,
  notice,
  children,
}: {
  toolbar: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={s.page} data-list-page="true">
      <div className={s.toolbar} data-list-toolbar="true">{toolbar}</div>
      {notice && <div className={s.notice} data-list-notice="true">{notice}</div>}
      <div className={s.content} data-list-content="true">{children}</div>
    </div>
  );
}

export function ListViewport({
  children,
  pagination,
  className,
}: {
  children: ReactNode;
  pagination?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`${s.viewport}${className ? ` ${className}` : ""}`}
      data-list-viewport="true"
    >
      <div className={s.body} data-list-body="true">{children}</div>
      {pagination && (
        <div className={s.pagination} data-list-pagination="true">
          {pagination}
        </div>
      )}
    </div>
  );
}

export function DesktopTableFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`table-scroll ${s.tableFrame}${className ? ` ${className}` : ""}`}
      data-desktop-table-frame="true"
    >
      {children}
    </div>
  );
}
