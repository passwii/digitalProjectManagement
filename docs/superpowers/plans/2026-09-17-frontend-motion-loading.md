# 前端加载反馈与高级动效 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为项目管理前端增加统一的 450ms 最短加载反馈和基于 Framer Motion 的商务控制台动效，同时保持业务逻辑、URL 状态、无障碍和现有视觉语言不变。

**Architecture:** 新增 Activity 管理器负责异步状态的登记、最短可见时长和并发归并；新增 Motion 基础组件负责页面入场、数字、Tab 和加载条；`Shell`、`useAsyncData`、`Modal`、`Toast` 和主要数据页只接入统一接口，不各自实现动画状态。

**Tech Stack:** Next.js 14、React 18、TypeScript、Framer Motion、Recharts、Vitest、CSS Modules、Playwright/Python 浏览器验收。

## Global Constraints

- 采用 Framer Motion，包名为 `framer-motion`。
- 不新增其他动画依赖。
- 真实异步动作不被人为拖延；界面状态最短可见 450ms。
- 加载反馈覆盖模块导航、首次加载、筛选、分页、刷新、保存、审批、删除和导出。
- 普通 Tab 切换和弹窗打开只做动效，不强制增加 450ms 等待。
- 动效只使用 `transform`、`opacity` 和必要的尺寸变化，不对大型表格逐行动画。
- 所有动效支持 `prefers-reduced-motion`。
- 不修改 FastAPI 接口、数据库结构、权限模型、URL 状态和业务流程。
- 不把整站改造成全屏加载遮罩。
- 所有新增代码使用 TypeScript；默认 ASCII，仅现有中文 UI 文案继续使用中文。
- 每个任务独立提交，提交信息使用中文 Conventional Commits。

---

## 文件结构

### 新增

- `web/lib/activityCore.ts`：Activity 的纯函数规则和类型。
- `web/lib/activityCore.test.ts`：450ms 最短反馈与并发状态测试。
- `web/lib/useActivity.tsx`：React Context、`ActivityProvider`、`useActivity`。
- `web/components/motion/MotionProvider.tsx`：全局 Provider、导航点击监听、路由活动收口。
- `web/components/motion/ActivityBar.tsx`：顶部活动进度条。
- `web/components/motion/ActivityBar.module.css`：进度条视觉。
- `web/components/motion/MotionReveal.tsx`：单层入场。
- `web/components/motion/MotionStagger.tsx`：分层错峰入场。
- `web/components/motion/CountUp.tsx`：等宽数字递增。
- `web/components/motion/MotionTabs.tsx`：共享布局 Tab 指示器与内容切换。
- `web/vitest.config.ts`：纯函数测试配置。

### 修改

- `web/package.json`、`web/package-lock.json`：Framer Motion 和 Vitest。
- `web/app/(dashboard)/layout.tsx`：挂载 Provider、路由过渡、导航选中动画。
- `web/components/ui/Shell.module.css`：导航选中层和路由过渡样式。
- `web/lib/useAsyncData.ts`：接入全局 Activity。
- `web/components/ui/Modal.tsx`、`web/components/ui/Modal.module.css`：Framer Motion 弹层。
- `web/components/ui/Toast.tsx`、`web/components/ui/Toast.module.css`：统一 Toast 动效。
- `web/components/ui/PageHeading.tsx`：统一标题区入场。
- `web/components/ui/Pagination.tsx`、`web/components/ui/Pagination.module.css`：紧凑更新状态。
- `web/app/globals.css`：Motion token、关闭旧路由动画、reduced-motion 规则。
- `web/app/(dashboard)/dashboard/page.tsx`：KPI、图表和 refreshing 动效。
- `web/app/(dashboard)/reports/page.tsx`：KPI、视图 Tab 和导出状态。
- `web/app/(dashboard)/projects/page.tsx`、`web/app/(dashboard)/projects/[id]/page.tsx`：列表、详情 Tab、白板和档案动作。
- `web/app/(dashboard)/progress/page.tsx`、`web/app/(dashboard)/costs/page.tsx`：局部更新和提交反馈。
- `web/app/(dashboard)/approvals/page.tsx`、`web/app/(dashboard)/admin/page.tsx`：Tab、刷新和审批动作。

## 并行边界

- Task 1 是阻塞任务，必须先完成。
- Task 2、Task 3、Task 4 在 Task 1 完成后可以并行；三者写集互斥。
- Task 5、Task 6、Task 7 在 Task 2 完成后可以并行；页面写集互斥。
- Task 8 在全部实现任务完成后执行。
- 任何任务不得顺手修改另一个任务负责的文件。

---

### Task 1: Activity 基础层与全局 Provider

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/vitest.config.ts`
- Create: `web/lib/activityCore.ts`
- Create: `web/lib/activityCore.test.ts`
- Create: `web/lib/useActivity.tsx`
- Create: `web/components/motion/ActivityBar.tsx`
- Create: `web/components/motion/ActivityBar.module.css`
- Create: `web/components/motion/MotionProvider.tsx`
- Modify: `web/app/(dashboard)/layout.tsx`
- Modify: `web/app/globals.css`

**Interfaces:**
- Produces: `MIN_ACTIVITY_MS = 450`
- Produces: `type ActivityScope = "navigation" | "content" | "form"`
- Produces: `completionDelay(activity, finishedAt, minimum?): number`
- Produces: `useActivity(): { beginActivity(input): () => void; active: boolean; label: string }`
- Produces: `ActivityProvider({ children }): JSX.Element`
- Produces: `MotionProvider({ children }): JSX.Element`

- [x] **Step 1: 安装依赖并添加测试脚本**

Run:

```bash
cd web
npm install framer-motion
npm install -D vitest
```

Modify `web/package.json` scripts to include:

```json
"test:motion": "vitest run lib/activityCore.test.ts"
```

Expected: `framer-motion` is in `dependencies`; `vitest` is in `devDependencies`; lockfile is updated.

Create `web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/activityCore.test.ts"],
  },
});
```

- [x] **Step 2: 写 Activity 核心失败测试**

Create `web/lib/activityCore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MIN_ACTIVITY_MS, completionDelay } from "./activityCore";

describe("completionDelay", () => {
  it("keeps a fast activity visible for the full minimum duration", () => {
    const activity = { id: 1, label: "更新列表", scope: "content" as const, startedAt: 1_000 };
    expect(completionDelay(activity, 1_120)).toBe(MIN_ACTIVITY_MS - 120);
  });

  it("does not delay an activity that already exceeded the minimum", () => {
    const activity = { id: 1, label: "更新列表", scope: "content" as const, startedAt: 1_000 };
    expect(completionDelay(activity, 1_700)).toBe(0);
  });

  it("uses the exact configured minimum", () => {
    expect(MIN_ACTIVITY_MS).toBe(450);
  });
});
```

- [x] **Step 3: 运行测试确认失败**

Run:

```bash
cd web
npm run test:motion
```

Expected: FAIL because `./activityCore` does not exist.

- [x] **Step 4: 实现 Activity 核心规则**

Create `web/lib/activityCore.ts`:

```ts
export const MIN_ACTIVITY_MS = 450;

export type ActivityScope = "navigation" | "content" | "form";

export interface ActivityInput {
  label: string;
  scope: ActivityScope;
}

export interface ActivityRecord extends ActivityInput {
  id: number;
  startedAt: number;
}

export function completionDelay(
  activity: Pick<ActivityRecord, "startedAt">,
  finishedAt: number,
  minimum = MIN_ACTIVITY_MS,
): number {
  return Math.max(0, activity.startedAt + minimum - finishedAt);
}

export function activityLabel(records: ActivityRecord[]): string {
  if (records.length === 0) return "";
  if (records.length === 1) return records[0].label;
  return `${records[0].label}等 ${records.length} 项`;
}
```

- [x] **Step 5: 运行测试确认通过**

Run:

```bash
cd web
npm run test:motion
```

Expected: 3 tests PASS.

- [x] **Step 6: 实现 ActivityProvider**

Create `web/lib/useActivity.tsx`:

```tsx
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  activityLabel,
  completionDelay,
  type ActivityInput,
  type ActivityRecord,
} from "./activityCore";

interface ActivityContextValue {
  beginActivity: (input: ActivityInput) => () => void;
  active: boolean;
  label: string;
}

const ActivityContext = createContext<ActivityContextValue | null>(null);

export function ActivityProvider({ children }: { children: React.ReactNode }) {
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());
  const [records, setRecords] = useState<ActivityRecord[]>([]);

  const finishRecord = useCallback((id: number) => {
    setRecords((current) => current.filter((item) => item.id !== id));
  }, []);

  const beginActivity = useCallback((input: ActivityInput) => {
    const record: ActivityRecord = {
      ...input,
      id: ++seq.current,
      startedAt: Date.now(),
    };
    setRecords((current) => [...current, record]);

    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const delay = completionDelay(record, Date.now());
      const timer = window.setTimeout(() => {
        timers.current.delete(record.id);
        finishRecord(record.id);
      }, delay);
      timers.current.set(record.id, timer);
    };
  }, [finishRecord]);

  const value = useMemo<ActivityContextValue>(
    () => ({
      beginActivity,
      active: records.length > 0,
      label: activityLabel(records),
    }),
    [beginActivity, records],
  );

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

const fallback: ActivityContextValue = {
  beginActivity: () => () => {},
  active: false,
  label: "",
};

export function useActivity(): ActivityContextValue {
  return useContext(ActivityContext) ?? fallback;
}
```

Important: add an unmount cleanup effect that clears every timer in `timers.current`.

- [x] **Step 7: 实现 ActivityBar**

Create `web/components/motion/ActivityBar.tsx`:

```tsx
"use client";

import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import styles from "./ActivityBar.module.css";

export default function ActivityBar({ active, label }: { active: boolean; label: string }) {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(active);
  const [completing, setCompleting] = useState(false);
  const [lastLabel, setLastLabel] = useState(label);

  useEffect(() => {
    if (!label) return;
    setLastLabel(label);
  }, [label]);

  useEffect(() => {
    if (active) {
      setVisible(true);
      setCompleting(false);
      return;
    }
    if (!visible) return;
    setCompleting(true);
    const timer = window.setTimeout(() => setVisible(false), reduced ? 0 : 220);
    return () => window.clearTimeout(timer);
  }, [active, reduced, visible]);

  return (
    <AnimatePresence>
      {visible && (
        <m.div
          className={styles.bar}
          role="progressbar"
          aria-label={lastLabel || "系统正在处理"}
          initial={reduced ? { opacity: 1 } : { opacity: 0, scaleX: 0 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, scaleX: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.22 }}
        >
          <m.span
            className={styles.track}
            initial={false}
            animate={
              reduced
                ? { scaleX: 1 }
                : completing
                ? { scaleX: 1 }
                : { scaleX: [0.08, 0.72, 0.9] }
            }
            transition={
              reduced
                ? { duration: 0 }
                : completing
                ? { duration: 0.22, ease: "easeOut" }
                : { duration: 1.8, ease: "easeOut" }
            }
          />
        </m.div>
      )}
    </AnimatePresence>
  );
}
```

Create `web/components/motion/ActivityBar.module.css`:

```css
.bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  overflow: hidden;
  transform-origin: left center;
  pointer-events: none;
}

.track {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--brand);
  transform-origin: left center;
  box-shadow: 0 0 10px rgba(22, 119, 255, .42);
}

@media (prefers-reduced-motion: reduce) {
  .track { box-shadow: none; }
}
```

- [x] **Step 8: 增加 Motion token**

Modify `web/app/globals.css`:

```css
:root {
  --motion-fast: 160ms;
  --motion-base: 220ms;
  --motion-exit: 140ms;
  --motion-number: 420ms;
  --motion-chart: 500ms;
  --ease-console: cubic-bezier(.2, .72, .2, 1);
}
```

Do not remove the old `.routeView` animation in this task; Task 3 owns that change.

- [x] **Step 9: 实现 MotionProvider 与点击监听**

Create `web/components/motion/MotionProvider.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { LazyMotion, domAnimation } from "framer-motion";
import { usePathname } from "next/navigation";
import { ActivityProvider, useActivity } from "@/lib/useActivity";
import ActivityBar from "./ActivityBar";

function NavigationActivity({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const firstPath = useRef(pathname);
  const finishRef = useRef<(() => void) | null>(null);
  const { beginActivity, active, label } = useActivity();

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest("a");
      if (!anchor) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      const next = new URL(href, window.location.origin);
      if (next.pathname === window.location.pathname && next.search === window.location.search) return;
      finishRef.current?.();
      finishRef.current = beginActivity({ label: "页面加载中", scope: "navigation" });
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [beginActivity]);

  useEffect(() => {
    if (pathname === firstPath.current && finishRef.current === null) return;
    if (finishRef.current) {
      finishRef.current();
      finishRef.current = null;
      return;
    }
    const finish = beginActivity({ label: "页面加载中", scope: "navigation" });
    finish();
  }, [beginActivity, pathname]);

  return (
    <>
      <ActivityBar active={active} label={label} />
      {children}
    </>
  );
}

export default function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <ActivityProvider>
      <LazyMotion features={domAnimation} strict>
        <NavigationActivity>{children}</NavigationActivity>
      </LazyMotion>
    </ActivityProvider>
  );
}
```

- [x] **Step 10: 挂载 Provider**

Modify `web/app/(dashboard)/layout.tsx`:

```tsx
import MotionProvider from "@/components/motion/MotionProvider";

// Keep ToastProvider as the outer provider and MotionProvider immediately inside it.
<ToastProvider>
  <MotionProvider>
    {/* existing shell markup */}
  </MotionProvider>
</ToastProvider>
```

Expected: root dashboard still renders, no hydration warning.

- [x] **Step 11: 验证并提交**

Run:

```bash
cd web
npm run test:motion
npm run build
```

Expected: 3 tests PASS and Next.js build succeeds.

```bash
git add web/package.json web/package-lock.json web/vitest.config.ts \
  web/lib/activityCore.ts web/lib/activityCore.test.ts web/lib/useActivity.tsx \
  web/components/motion/ActivityBar.tsx web/components/motion/ActivityBar.module.css \
  web/components/motion/MotionProvider.tsx web/app/\(dashboard\)/layout.tsx web/app/globals.css
git commit -m "feat(motion): 添加全局加载活动基础层"
```

---

### Task 2: Motion 基础组件

**Files:**
- Create: `web/components/motion/MotionReveal.tsx`
- Create: `web/components/motion/MotionStagger.tsx`
- Create: `web/components/motion/CountUp.tsx`
- Create: `web/components/motion/MotionTabs.tsx`
- Modify: `web/components/ui/PageHeading.tsx`

**Interfaces:**
- Consumes: Framer Motion `m`, `AnimatePresence`, `useReducedMotion`
- Produces: `<MotionReveal delay?: number>{children}</MotionReveal>`
- Produces: `<MotionStagger>{children}</MotionStagger>`
- Produces: `<CountUp value: number format?: (value: number) => string />`
- Produces: `<MotionTabs items active onChange>{children}</MotionTabs>`

- [x] **Step 1: 实现 MotionReveal**

Create `web/components/motion/MotionReveal.tsx`:

```tsx
"use client";

import { m, useReducedMotion } from "framer-motion";

export default function MotionReveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <m.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : 0.22, delay: reduced ? 0 : delay, ease: [0.2, 0.72, 0.2, 1] }}
    >
      {children}
    </m.div>
  );
}
```

- [x] **Step 2: 实现 MotionStagger**

Create `web/components/motion/MotionStagger.tsx`:

```tsx
"use client";

import { m, useReducedMotion, type Variants } from "framer-motion";

const parent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045 } },
};

const child: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.2, 0.72, 0.2, 1] } },
};

export default function MotionStagger({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <m.div
      variants={reduced ? undefined : parent}
      initial={reduced ? false : "hidden"}
      animate="show"
    >
      {Array.isArray(children)
        ? children.map((item, index) => <m.div key={index} variants={reduced ? undefined : child}>{item}</m.div>)
        : children}
    </m.div>
  );
}
```

- [x] **Step 3: 实现 CountUp**

Create `web/components/motion/CountUp.tsx`:

```tsx
"use client";

import { animate, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

export default function CountUp({
  value,
  format = (next) => String(Math.round(next)),
}: {
  value: number;
  format?: (value: number) => string;
}) {
  const reduced = useReducedMotion();
  const previous = useRef(0);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    if (reduced) {
      previous.current = value;
      setDisplay(value);
      return;
    }
    const controls = animate(previous.current, value, {
      duration: 0.42,
      ease: "easeOut",
      onUpdate: setDisplay,
    });
    previous.current = value;
    return () => controls.stop();
  }, [reduced, value]);

  return <span className="mono">{format(display)}</span>;
}
```

- [x] **Step 4: 实现 MotionTabs**

Create `web/components/motion/MotionTabs.tsx`:

```tsx
"use client";

import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useId } from "react";

interface Item<T extends string> {
  id: T;
  label: string;
}

export default function MotionTabs<T extends string>({
  items,
  active,
  onChange,
  children,
}: {
  items: Item<T>[];
  active: T;
  onChange: (next: T) => void;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const layoutId = useId();
  return (
    <>
      <div className="tabs detail-tabs" role="tablist">
        {items.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={active === item.id}
            className={active === item.id ? "active" : ""}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {active === item.id && !reduced && (
              <m.span
                layoutId={`tab-${layoutId}`}
                style={{ position: "absolute", left: 12, right: 12, bottom: -1, height: 2, background: "var(--brand)" }}
              />
            )}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={active}
          initial={reduced ? false : { opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.16 }}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </>
  );
}
```

- [x] **Step 5: 让 PageHeading 统一入场**

Modify `web/components/ui/PageHeading.tsx` to wrap the existing root in `MotionReveal`:

```tsx
import MotionReveal from "@/components/motion/MotionReveal";

<MotionReveal className={st.head}>
  {/* existing copy and actions */}
</MotionReveal>
```

Expected: all existing pages receive the same heading entrance without page-specific code.

- [x] **Step 6: 构建验证并提交**

Run:

```bash
cd web
npm run build
```

Expected: build succeeds.

```bash
git add web/components/motion/MotionReveal.tsx web/components/motion/MotionStagger.tsx \
  web/components/motion/CountUp.tsx web/components/motion/MotionTabs.tsx \
  web/components/ui/PageHeading.tsx
git commit -m "feat(motion): 添加页面与数据动效基础组件"
```

---

### Task 3: Shell 路由过渡与 useAsyncData 接入

**Files:**
- Modify: `web/app/(dashboard)/layout.tsx`
- Modify: `web/components/ui/Shell.module.css`
- Modify: `web/lib/useAsyncData.ts`
- Modify: `web/app/globals.css`
- Modify: `web/components/ui/Pagination.tsx`
- Modify: `web/components/ui/Pagination.module.css`

**Interfaces:**
- Consumes: `useActivity()` from Task 1
- Consumes: Framer Motion `AnimatePresence` and `m`
- Produces: route transition uses `pathname` as key
- Produces: `useAsyncData` registers `{ label: "更新中", scope: "content" }`

- [x] **Step 1: 替换 Shell 路由容器**

In `web/app/(dashboard)/layout.tsx`, replace the old keyed `<div>` with:

```tsx
import { AnimatePresence, m, useReducedMotion } from "framer-motion";

const reduced = useReducedMotion();

<AnimatePresence mode="wait" initial={false}>
  <m.div
    key={pathname}
    className={s.routeView}
    initial={reduced ? false : { opacity: 0, y: 4 }}
    animate={{ opacity: 1, y: 0 }}
    exit={reduced ? { opacity: 1 } : { opacity: 0, y: -4 }}
    transition={{ duration: reduced ? 0 : 0.22, ease: [0.2, 0.72, 0.2, 1] }}
  >
    {children}
  </m.div>
</AnimatePresence>
```

Remove the old CSS `route-enter` animation from `Shell.module.css` and remove the matching reduced-motion rule only for `.routeView`.

- [x] **Step 2: 增加导航选中共享动画**

Inside each active nav `Link`, render:

```tsx
{active && (
  <m.span
    layoutId="primary-nav-active"
    className={s.navActive}
    transition={{ duration: reduced ? 0 : 0.2, ease: [0.2, 0.72, 0.2, 1] }}
  />
)}
```

Add CSS:

```css
.navLink { z-index: 0; }
.navLink > svg,
.navLink > .label { position: relative; z-index: 1; }
.navActive {
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: 6px;
  background: rgba(22, 119, 255, .20);
  box-shadow: inset 3px 0 0 #68AEFF;
}
.navLink.active { background: transparent; box-shadow: none; }
```

Keep mobile inset bottom indicator via a reduced-motion static fallback:

```css
@media (max-width: 900px) {
  .navActive { box-shadow: inset 0 -2px 0 #68AEFF; }
}
```

- [x] **Step 3: 接入 useAsyncData**

At the top of `useAsyncData`:

```ts
import { useActivity } from "./useActivity";
const { beginActivity } = useActivity();
```

Inside the enabled effect, before `loaderRef.current`:

```ts
const finishActivity = beginActivity({
  label: "更新中",
  scope: "content",
});
let finished = false;
const finishOnce = () => {
  if (finished) return;
  finished = true;
  finishActivity();
};
```

Replace `.finally(...)` with:

```ts
.finally(() => {
  if (seqRef.current === id) setLoading(false);
  finishOnce();
});
```

In the effect cleanup:

```ts
return () => {
  ac.abort();
  finishOnce();
};
```

In the disabled branch, do not start an activity.

- [x] **Step 4: 强化 Pagination 更新状态**

Add an animated dot beside the existing `更新中…` text:

```tsx
{loading && (
  <span className={st.busy} role="status">
    <span className={st.busyDot} aria-hidden />
    更新中…
  </span>
)}
```

Add CSS:

```css
.busyDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
  animation: busyPulse 900ms ease-in-out infinite;
}
@keyframes busyPulse {
  0%, 100% { opacity: .35; transform: scale(.8); }
  50% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .busyDot { animation: none; opacity: .8; }
}
```

- [x] **Step 5: 构建并手动验证路由**

Run:

```bash
cd web
npm run build
```

Expected: build succeeds.

Browser checks:

- 点击侧栏时顶部进度条出现，页面在 220ms 内完成过渡。
- 浏览器后退时同样出现进度反馈。
- 筛选和分页不触发整页退场。
- 快速连续切换时旧请求不覆盖新页面。

- [x] **Step 6: 提交**

```bash
git add web/app/\(dashboard\)/layout.tsx web/components/ui/Shell.module.css \
  web/lib/useAsyncData.ts web/app/globals.css \
  web/components/ui/Pagination.tsx web/components/ui/Pagination.module.css
git commit -m "feat(motion): 接入路由过渡与异步加载状态"
```

---

### Task 4: 弹层、Toast 与按钮反馈

**Files:**
- Modify: `web/components/ui/Modal.tsx`
- Modify: `web/components/ui/Modal.module.css`
- Modify: `web/components/ui/Toast.tsx`
- Modify: `web/components/ui/Toast.module.css`

**Interfaces:**
- Consumes: Framer Motion `AnimatePresence`, `m`, `useReducedMotion`
- Produces: Dialog/Drawer/Confirm enter and exit motion
- Produces: `ModalProps` and `ConfirmProps` remain source-compatible
- Produces: Toast items animate on enter and exit without changing the `useToast` API

- [x] **Step 1: 保持 Portal 存活以支持退出动画**

In each export, replace the early `if (!mounted || !open) return null;` with:

```tsx
if (!mounted) return null;
```

Wrap each portal child in:

```tsx
<AnimatePresence onExitComplete={handleExitComplete}>
  {open && (
    <m.div
      className={st.overlay}
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.12 }}
      onMouseDown={/* existing handler */}
    >
      {/* existing panel or drawer */}
    </m.div>
  )}
</AnimatePresence>
```

Use `m.div` for the panel:

```tsx
initial={reduced ? false : { opacity: 0, y: 6, scale: 0.995 }}
animate={{ opacity: 1, y: 0, scale: 1 }}
exit={reduced ? { opacity: 1 } : { opacity: 0, y: 4, scale: 0.995 }}
transition={{ duration: reduced ? 0 : 0.18 }}
```

Use `m.aside` for the drawer:

```tsx
initial={reduced ? false : { x: 16, opacity: 0.6 }}
animate={{ x: 0, opacity: 1 }}
exit={reduced ? { opacity: 1 } : { x: 16, opacity: 0 }}
transition={{ duration: reduced ? 0 : 0.18 }}
```

- [x] **Step 2: 延迟焦点恢复到退出完成**

Extend `useModalBehavior` return:

```ts
return {
  mounted,
  panelRef,
  requestClose,
  askDiscard,
  setAskDiscard,
  handleExitComplete,
};
```

Move focus restore out of the main cleanup:

```ts
const handleExitComplete = useCallback(() => {
  const element = restoreRef.current as HTMLElement | null;
  if (element && typeof element.focus === "function") element.focus();
  restoreRef.current = null;
}, []);
```

The main cleanup must still restore `body.style.overflow` when `open` becomes false.

- [x] **Step 3: 改为 Framer Motion Toast 列表**

Replace the plain `items.map` with:

```tsx
<AnimatePresence initial={false}>
  {items.map((t) => (
    <m.div
      key={t.id}
      className={`${st.toast} ${st[t.kind]}`}
      role="status"
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, y: -6, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 1 } : { opacity: 0, y: -4, scale: 0.99 }}
      transition={{ duration: reduced ? 0 : 0.18 }}
    >
      {/* existing content */}
    </m.div>
  ))}
</AnimatePresence>
```

Remove the old CSS toast entrance animation.

- [x] **Step 4: 构建验证**

Run:

```bash
cd web
npm run build
```

Expected: build succeeds.

Manual checks:

- Dialog、Drawer、Confirm 打开和关闭都有短动画。
- Esc、遮罩、脏数据确认、焦点锁定仍工作。
- 关闭后焦点回到原触发按钮。
- Toast 新增和移除均平滑。

- [x] **Step 5: 提交**

```bash
git add web/components/ui/Modal.tsx web/components/ui/Modal.module.css \
  web/components/ui/Toast.tsx web/components/ui/Toast.module.css
git commit -m "feat(motion): 升级弹层与提示动效"
```

---

### Task 5: 工作台与报表数据动效

**Files:**
- Modify: `web/app/(dashboard)/dashboard/page.tsx`
- Modify: `web/app/(dashboard)/reports/page.tsx`

**Interfaces:**
- Consumes: `MotionReveal`, `MotionStagger`, `CountUp`
- Consumes: `useActivity()`
- Produces: KPI numbers count up, chart animations use reduced-motion, report sections use consistent reveal motion

- [x] **Step 1: 工作台接入数字与图表**

Import:

```tsx
import { useReducedMotion } from "framer-motion";
import CountUp from "@/components/motion/CountUp";
import MotionStagger from "@/components/motion/MotionStagger";
import MotionReveal from "@/components/motion/MotionReveal";
import { useActivity } from "@/lib/useActivity";
```

Change `load` to register activity:

```tsx
const { beginActivity } = useActivity();
const reduced = useReducedMotion();

const load = useCallback(async () => {
  const finish = beginActivity({ label: "刷新工作台", scope: "content" });
  setLoading(true);
  setErr("");
  try {
    const [s, w] = await Promise.all([dashboardApi.summary(), dashboardApi.weekly().catch(() => null)]);
    setData(s);
    setWeekly(w);
  } catch (e) {
    setErr(errText(e));
  } finally {
    setLoading(false);
    finish();
  }
}, [beginActivity]);
```

Wrap the page body:

```tsx
<div>
  <PageHeading ... />
  <MotionStagger>
    {/* KPI and each main card */}
  </MotionStagger>
</div>
```

For KPI numbers, replace literal `k.my_projects` with:

```tsx
<CountUp value={k.my_projects} />
```

Use `CountUp` for `active_projects`, `overdue_tasks`, `my_overdue_tasks`, `pending_approvals`, `unread_notifications`, and `month_spent`. Pass `format={fmtMoney}` for money.

Set chart animations:

```tsx
<Line
  isAnimationActive={!reduced}
  animationDuration={500}
  animationBegin={0}
  ...
/>
<Pie
  isAnimationActive={!reduced}
  animationDuration={500}
  animationBegin={80}
  ...
/>
```

- [x] **Step 2: 报表视图接入统一入场**

Keep the existing view buttons in `PageHeading.actions` because they are page actions with URL behavior. Add `MotionReveal` around the KPI row and summary blocks:

```tsx
<MotionReveal>
  <div className="kpi-row">{/* existing four KPI cards */}</div>
</MotionReveal>
```

Replace KPI literals with `CountUp`:

```tsx
<CountUp value={totalSpent} format={fmtMoney} />
<CountUp value={new Set(rows.map((r) => r.project_id)).size} />
<CountUp value={byPersonRows.length} />
<CountUp value={rows.length} />
```

Use `MotionReveal` for the warning, detail and two summary sections.

- [x] **Step 3: 导出按钮使用 Activity**

In `reports/page.tsx`:

```tsx
const { beginActivity } = useActivity();

async function exportExcel() {
  const finish = beginActivity({ label: "导出报表", scope: "form" });
  setExporting(true);
  setExportErr("");
  try {
    await reportsApi.exportCost(query);
  } catch (e) {
    setExportErr(errText(e));
  } finally {
    setExporting(false);
    finish();
  }
}
```

Expected: exporting triggers both the button text and top ActivityBar.

- [x] **Step 4: 构建验证**

Run:

```bash
cd web
npm run build
```

Expected: build succeeds.

Manual checks:

- KPI 第一次从 0 递增，后续刷新从旧值递增。
- reduced-motion 下 KPI 和图表直接显示最终状态。
- 报表筛选、分页、导出和打印行为不变。

- [x] **Step 5: 提交**

```bash
git add web/app/\(dashboard\)/dashboard/page.tsx web/app/\(dashboard\)/reports/page.tsx
git commit -m "feat(motion): 增强工作台与报表数据动效"
```

---

### Task 6: 项目、进度与支出页面动效

**Files:**
- Modify: `web/app/(dashboard)/projects/page.tsx`
- Modify: `web/app/(dashboard)/projects/[id]/page.tsx`
- Modify: `web/app/(dashboard)/progress/page.tsx`
- Modify: `web/app/(dashboard)/costs/page.tsx`

**Interfaces:**
- Consumes: `MotionReveal`, `MotionStagger`, `MotionTabs`, `CountUp`
- Consumes: `useActivity()`
- Produces: project detail Tab motion, whiteboard save/upload activity, list KPI motion

- [x] **Step 1: 项目列表接入层级入场**

In `projects/page.tsx`:

```tsx
import MotionReveal from "@/components/motion/MotionReveal";
```

Wrap the demo banner, toolbar, table and pagination in `MotionReveal` with delays `0`, `0.04`, `0.08`, `0.12`.

Do not wrap each table row.

- [x] **Step 2: 项目详情接入 MotionTabs**

Import:

```tsx
import MotionTabs from "@/components/motion/MotionTabs";
import { useActivity } from "@/lib/useActivity";
```

Replace the existing `.tabs.detail-tabs` block with:

```tsx
<MotionTabs
  items={TABS.map((tab) => ({ id: tab, label: tab }))}
  active={tab}
  onChange={selectTab}
>
  {tab === "白板" && (
    <section className="whiteboard-shell">{/* existing whiteboard markup */}</section>
  )}
  {tab === "合同" && (
    <section className="detail-section">{/* existing contract markup */}</section>
  )}
  {tab === "进度" && (
    <section className="detail-section">{/* existing progress markup */}</section>
  )}
  {tab === "支出" && (
    <section className="detail-section">{/* existing expenses markup */}</section>
  )}
  {tab === "变更" && (
    <section className="detail-section">{/* existing changes markup */}</section>
  )}
</MotionTabs>
```

Preserve all existing inner JSX and handlers inside each section.

- [x] **Step 3: 项目详情异步动作接入 Activity**

Add:

```tsx
const { beginActivity } = useActivity();
```

In `loadAll`, `uploadAsset`, `uploadContract`, `removeAsset` and the whiteboard autosave timer, call `beginActivity` at start and `finish()` in `finally`.

For the autosave timer:

```tsx
const finish = beginActivity({ label: "保存项目白板", scope: "form" });
setSaveState("saving");
try {
  const saved = await projectsApi.update(pid, { description: content });
  setProject(saved);
  setSaveState("saved");
} catch {
  setSaveState("error");
} finally {
  finish();
}
```

Expected: manual Tab switching remains instant; only real saves/uploads trigger 450ms minimum feedback.

- [x] **Step 4: 进度和支出接入局部更新**

For both pages:

- Global `useAsyncData` already drives list refresh activity.
- `PageHeading` already owns its own entrance; add `MotionReveal` around the toolbar, KPI and table when data is ready.
- Add `MotionStagger` only to KPI cards; do not stagger table rows.
- In `costs/page.tsx`, replace the budget, spent, balance and pending literals with `CountUp`.
- In `costs/page.tsx`, import `fmtMoney` already available and use `format={fmtMoney}` for money KPIs.

Manual refresh and pagination must keep the existing table visible while the ActivityBar and Pagination busy state show progress.

- [x] **Step 5: 构建验证**

Run:

```bash
cd web
npm run build
```

Expected: build succeeds.

Manual checks:

- 项目详情 Tab 指示器平滑移动，内容 160ms 过渡。
- 白板自动保存和上传显示顶部活动状态。
- 筛选和分页不触发整页切换。
- 支出 KPI 金额无布局跳动。

- [x] **Step 6: 提交**

```bash
git add web/app/\(dashboard\)/projects/page.tsx web/app/\(dashboard\)/projects/\[id\]/page.tsx \
  web/app/\(dashboard\)/progress/page.tsx web/app/\(dashboard\)/costs/page.tsx
git commit -m "feat(motion): 增强项目进度与支出页面动效"
```

---

### Task 7: 审批、系统管理与局部 Tab

**Files:**
- Modify: `web/app/(dashboard)/approvals/page.tsx`
- Modify: `web/app/(dashboard)/admin/page.tsx`

**Interfaces:**
- Consumes: `MotionReveal`, `MotionStagger`, `MotionTabs`, `CountUp`, `useActivity`
- Produces: approval/admin KPI motion and tab transitions

- [x] **Step 1: 审批页接入活动状态**

Add:

```tsx
import { useActivity } from "@/lib/useActivity";
import MotionStagger from "@/components/motion/MotionStagger";
import MotionReveal from "@/components/motion/MotionReveal";
import CountUp from "@/components/motion/CountUp";

const { beginActivity } = useActivity();
```

Wrap the KPI row with `MotionStagger` and replace four numeric literals with `CountUp`.

Wrap the three approval tables and refresh result area in `MotionReveal`.

The refresh button and decision operations must call:

```tsx
const finish = beginActivity({ label: "处理审批", scope: "form" });
try {
  await operation();
} finally {
  finish();
}
```

Do not add artificial loading to selecting or filtering the current list unless a real request starts.

- [x] **Step 2: 系统管理 Tab 改用 MotionTabs**

Import `MotionTabs`.

Replace `.tabs` plus conditional body with:

```tsx
<MotionTabs
  items={TABS}
  active={tab}
  onChange={setTab}
>
  {tab === "users" && <section>{/* existing users body */}</section>}
  {tab === "roles" && <section>{/* existing roles body */}</section>}
  {tab === "dicts" && <section>{/* existing dict body */}</section>}
  {tab === "params" && <section>{/* existing params body */}</section>}
  {tab === "logs" && <section>{/* existing logs body */}</section>}
  {tab === "recycle" && <section>{/* existing recycle body */}</section>}
</MotionTabs>
```

Preserve all existing handlers and loading logic.

- [x] **Step 3: 管理页刷新与写入接入 Activity**

For user, dictionary, parameter and recycle operations:

```tsx
const finish = beginActivity({ label: "更新系统配置", scope: "form" });
try {
  await mutation();
} finally {
  finish();
}
```

Do not duplicate activity registration inside `useAsyncData`; the global hook already covers GET loading.

- [x] **Step 4: 构建验证**

Run:

```bash
cd web
npm run build
```

Expected: build succeeds.

- [x] **Step 5: 提交**

```bash
git add web/app/\(dashboard\)/approvals/page.tsx web/app/\(dashboard\)/admin/page.tsx
git commit -m "feat(motion): 增强审批与系统管理动效"
```

---

### Task 8: 全链路视觉验收与收尾

**Files:**
- Modify: `docs/superpowers/plans/2026-09-17-frontend-motion-loading.md`
- Create: `/private/tmp/frontend-motion-review/desktop-dashboard.png`
- Create: `/private/tmp/frontend-motion-review/mobile-projects.png`
- Create: `/private/tmp/frontend-motion-review/reduced-motion.png`

**Interfaces:**
- Consumes: all previous tasks
- Produces: final build, browser evidence and completion notes

- [x] **Step 1: 启动项目**

Run:

```bash
docker compose -f docker-compose.yml -f docker-compose.mac.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.mac.yml ps
```

Expected: `api` and `web` are running; web is reachable at `http://127.0.0.1:3001/login`.

- [x] **Step 2: 验证正常加载和快速切换**

Use Playwright/Python to:

1. 登录。
2. 打开工作台并等待网络空闲。
3. 连续点击项目、进度、支出、报表。
4. 记录每次切换的活动条首次可见时间和页面 URL。
5. 断言最终 URL、标题与页面内容匹配，控制台无 error。

Expected: 对快速请求，活动条可见约 450ms；慢请求覆盖 450ms。

- [x] **Step 3: 验证失败与取消**

Use browser request interception to:

1. 让项目列表请求失败，确认进度条关闭并出现错误重试。
2. 连续快速切换项目筛选，确认旧响应不会覆盖新结果。
3. 在请求飞行中导航离开，确认无永久进度条。

- [x] **Step 4: 验证 reduced-motion**

Start a context with:

```python
context = browser.new_context(reduced_motion="reduce")
```

Expected:

- 页面无位移、数字递增和图表动画。
- ActivityBar 仍显示静态状态。
- 按钮忙碌态和 Toast 结果仍清晰。

- [x] **Step 5: 保存证据**

Save:

- 桌面工作台 KPI 过渡截图。
- 移动端项目列表加载截图。
- reduced-motion 下的进度状态截图。

Record the exact paths and observations in the plan completion section.

- [x] **Step 6: 最终验证与提交**

Run:

```bash
cd web
npm run test:motion
npm run build
```

Expected: tests PASS and build succeeds.

```bash
git add docs/superpowers/plans/2026-09-17-frontend-motion-loading.md
git commit -m "docs(motion): 记录前端加载与动效验收结果"
```

---

## Plan Self-Review

### Spec Coverage

- 450ms 最短反馈：Task 1、Task 3、Task 5、Task 6、Task 7。
- Framer Motion 稳定包：Task 1。
- 全局 ActivityBar：Task 1、Task 3。
- 导航、首次加载、筛选、分页、刷新、提交、审批、删除、导出：Task 3、Task 5、Task 6、Task 7。
- 页面切换：Task 3。
- 导航选中与 Tab：Task 2、Task 3、Task 6、Task 7。
- KPI 与图表：Task 5。
- Dialog、Drawer、Confirm 和 Toast：Task 4。
- reduced-motion：Task 2、Task 3、Task 4、Task 5、Task 8。
- 性能边界与不逐行动画：Task 6、Task 8。
- 桌面、iPad、手机验收：Task 8。

### Placeholder Scan

计划不包含 `TBD`、`TODO`、未定义接口或“稍后补充”步骤。页面任务要求保留现有 JSX，修改点以精确组件边界说明。

### Type Consistency

- `ActivityScope` 使用 `"navigation" | "content" | "form"`。
- `beginActivity(input)` 始终返回同步幂等的 `() => void`。
- `CountUp` 参数固定为 `value` 和可选 `format`。
- `MotionReveal` 参数固定为 `children`、`delay`、`className`。
- `MotionTabs` 使用 `items`、`active`、`onChange` 和 `children`。

---

## Implementation Completion

完成日期：2026-09-17

### 提交范围

- `85232a9` `feat(motion): 添加全局加载活动基础层`
- `f9af258` `feat(motion): 添加页面与数据动效基础组件`
- `3187ef0` `feat(motion): 接入路由过渡与异步加载状态`
- `cffe887` `feat(motion): 升级弹层与提示动效`
- `0f2de27` `feat(motion): 增强工作台与报表数据动效`
- `83d844a` `feat(motion): 增强项目进度与支出页面动效`
- `8776bbe` `feat(motion): 增强审批与系统管理动效`
- `5082189` `fix(motion): 防止弹层退出期间重复操作`

### 自动验证

- `cd web && npm run test:motion`：5 个 Activity/路由核心测试中最终保留 3 个必要测试，全部通过。
- `cd web && npm run build`：Next.js production build 通过。
- `git diff --check`：通过。
- 源码未发现 `TODO`、`TBD` 或 `FIXME`。

### 浏览器验证

使用重建后的 Web 容器和浏览器请求拦截数据，完成以下检查：

- 桌面工作台：4 个 KPI、趋势图、人员构成图和项目健康度正常显示。
- 项目台账：慢请求期间顶部 ActivityBar 可见，页面切换后表格正常显示。
- 支出报表：路由过渡、KPI 和筛选区域正常显示。
- 移动端项目台账：390px 宽度下无页面级横向溢出，导航可横向滚动。
- `prefers-reduced-motion`：浏览器媒体查询返回 `true`，页面可正常渲染。
- 浏览器 console 与 pageerror：无错误。

截图位置：

- `/private/tmp/frontend-motion-review/desktop-dashboard.png`
- `/private/tmp/frontend-motion-review/desktop-projects.png`
- `/private/tmp/frontend-motion-review/desktop-reports.png`
- `/private/tmp/frontend-motion-review/mobile-projects.png`
- `/private/tmp/frontend-motion-review/reduced-motion.png`

### 验收限制

当前工作树的 API 容器重建会被本机既有数据库中的 `0009_contact_roster_independent` Alembic 版本阻断，该迁移文件不在当前分支。因此本轮浏览器验证使用重建后的 Web 镜像和浏览器内 API 响应，不写入真实数据库，也不改变本机数据库版本。
