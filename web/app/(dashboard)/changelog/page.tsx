"use client";

import { useState } from "react";
import {
  CHANGELOG_VERSIONS,
  type ChangelogEntry,
  type ChangelogKind,
  type ChangelogVersion,
  type ChangelogVersionId,
} from "@/lib/changelog";
import s from "./changelog.module.css";
import { useRegisterPageTitle } from "@/components/ui/PageTitleContext";

const KIND_CLASS: Record<ChangelogKind, string> = {
  功能: s.kindFeature,
  优化: s.kindImprove,
  修复: s.kindFix,
  移动端: s.kindMobile,
  财务: s.kindFinance,
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
  const [activeId, setActiveId] = useState<ChangelogVersionId>("v2");
  const active = CHANGELOG_VERSIONS.find((version) => version.id === activeId) ?? CHANGELOG_VERSIONS[0];
  const updateCount = active.days.reduce((count, day) => count + day.entries.length, 0);

  return (
    <div className={s.page}>
      <header className={s.hero}>
        <div>
          <h1 className="sr-only">功能更新</h1>
        </div>
        <div className={s.currentMark} aria-label="V2 当前版本">
          <span>当前版本</span>
          <strong>V2</strong>
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
