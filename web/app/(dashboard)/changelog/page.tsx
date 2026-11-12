"use client";

import { useState } from "react";
import {
  CHANGELOG_CURRENT_VERSION,
  CHANGELOG_VERSIONS,
  type ChangelogEntry,
  type ChangelogKind,
  type ChangelogVersion,
  type ChangelogVersionId,
} from "@/lib/changelog";
import { CHANGELOG_CSS, s } from "./changelogStyles";
import { useRegisterPageTitle } from "@/components/ui/PageTitleContext";

const KIND_CLASS: Record<ChangelogKind, string> = {
  功能: s.kindFeature,
  优化: s.kindImprove,
  修复: s.kindFix,
  移动端: s.kindMobile,
  财务: s.kindFinance,
  架构: s.kindArch,
};

function formatDate(date: string) {
  return date.replace(/-/g, ".");
}

function VersionTabs({ active, onChange }: { active: ChangelogVersionId; onChange: (id: ChangelogVersionId) => void }) {
  return (
    <div className={s.tabs} role="tablist" aria-label="版本选择">
      {CHANGELOG_VERSIONS.map((version) => {
        const selected = active === version.id;
        return (
          <button
            key={version.id}
            type="button"
            role="tab"
            id={`changelog-tab-${version.id}`}
            aria-selected={selected}
            aria-controls={`changelog-panel-${version.id}`}
            className={`${s.tab} ${selected ? s.tabActive : ""}`}
            onClick={() => onChange(version.id)}
          >
            <span className={s.tabVersion}>{version.label}</span>
            <span>{version.title}</span>
          </button>
        );
      })}
    </div>
  );
}

function Entry({ entry }: { entry: ChangelogEntry }) {
  return (
    <article className={s.entry}>
      <span className={`${s.kind} ${KIND_CLASS[entry.kind]}`}>{entry.kind}</span>
      <div className={s.entryCopy}>
        <h3>{entry.title}</h3>
        <p>{entry.description}</p>
      </div>
    </article>
  );
}

function Timeline({ version }: { version: ChangelogVersion }) {
  return (
    <div className={s.timeline}>
      {version.days.map((day, index) => (
        <section className={`${s.day} ${index === 0 ? s.dayLatest : ""}`} key={day.date}>
          <div className={s.dateColumn}>
            <time dateTime={day.date}>{formatDate(day.date)}</time>
            {index === 0 && <span>最近更新</span>}
          </div>
          <div className={s.nodeColumn} aria-hidden="true">
            <span className={s.node} />
          </div>
          <div className={s.entries}>
            {day.entries.map((entry) => <Entry key={`${day.date}-${entry.title}`} entry={entry} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function ChangelogPage() {
  useRegisterPageTitle("功能更新");
  const [activeId, setActiveId] = useState<ChangelogVersionId>(CHANGELOG_CURRENT_VERSION.id);
  const active = CHANGELOG_VERSIONS.find((version) => version.id === activeId) ?? CHANGELOG_CURRENT_VERSION;
  const updateCount = active.days.reduce((count, day) => count + day.entries.length, 0);

  return (
    <div className={s.page}>
      {/*
        页面样式内联在路由自己的 JS 里，和 DOM 同一次提交落地。
        原因与实测数据见 ./changelogStyles.ts —— 换成 CSS Module 会在客户端
        路由切换时先画一帧无样式内容（CSS chunk 在首次提交之后才异步到达）。
      */}
      <style dangerouslySetInnerHTML={{ __html: CHANGELOG_CSS }} />
      <header className={s.hero}>
        <div>
          <h1 className="sr-only">功能更新</h1>
        </div>
        <div className={s.currentMark} aria-label={`${CHANGELOG_CURRENT_VERSION.label} 当前版本`}>
          <span>当前版本</span>
          <strong>{CHANGELOG_CURRENT_VERSION.label}</strong>
        </div>
      </header>

      <VersionTabs active={active.id} onChange={setActiveId} />

      <section
        className={s.panel}
        role="tabpanel"
        id={`changelog-panel-${active.id}`}
        aria-labelledby={`changelog-tab-${active.id}`}
      >
        <div className={s.panelHead}>
          <div>
            <h2>{active.label} · {active.title}</h2>
            <p>{active.summary}</p>
          </div>
          <div className={s.count}>
            <strong>{updateCount}</strong>
            <span>项更新</span>
          </div>
        </div>
        <Timeline version={active} />
      </section>
    </div>
  );
}
