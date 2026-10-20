import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 核心页必须留在服务端 HTML 里（P1 回归守卫）。
 *
 * 背景：`useSearchParams` 是 client bailout —— 它所在的**整棵子树**都不会进静态
 * HTML。为了读一个 `?q=` 把整个 `AlarmView` 包进 `<Suspense>`，`/stream-monitor/alarm` 的 50 条
 * 首屏就只剩 RSC payload：HTML 从 ~117KB 掉到 ~68KB、关 JS 只剩 180 字，慢网首屏
 * 从 320ms 涨到 1.8s。页面上看不出来，只能靠服务端产物或源码形状守。
 *
 * 这里锁两件事：
 *   1. 页面侧不得把 `AlarmView` / `EventView` 等核心视图包进 Suspense；
 *   2. `useSearchParams` 只能出现在「同步 URL 参数」的极小客户端组件里，
 *      并且那个组件自己在 Suspense 内。
 */

const sectionPage = readFileSync(resolve(process.cwd(), "app/stream-monitor/[section]/page.tsx"), "utf8");
const detailPage = readFileSync(resolve(process.cwd(), "app/stream-monitor/[section]/[id]/page.tsx"), "utf8");
const alarmView = readFileSync(resolve(process.cwd(), "components/av/pages/AlarmView.tsx"), "utf8");
const shell = readFileSync(resolve(process.cwd(), "components/av/AvShell.tsx"), "utf8");

describe("核心视图不被 Suspense 整体 bailout", () => {
  it("页面侧直接渲染 AlarmView，不套 Suspense", () => {
    expect(sectionPage).toMatch(/case "alarm":[\s\S]*?return <AlarmView \{\.\.\.\(await getAlarmData\(\)\)\} \/>;/);
    expect(detailPage).toMatch(/return <AlarmView \{\.\.\.\(await getAlarmData\(id\)\)\} \/>;/);
    // 一旦有人再包一层，这条会红
    expect(sectionPage).not.toMatch(/<Suspense[\s\S]{0,200}<AlarmView/);
    expect(detailPage).not.toMatch(/<Suspense[\s\S]{0,200}<AlarmView/);
  });

  it("AlarmView 里 useSearchParams 只出现在 QuerySync 这个小组件里", () => {
    const matches = alarmView.match(/useSearchParams\(/g) ?? [];
    expect(matches.length).toBe(1);
    // QuerySync 必须在 Suspense 内被渲染
    expect(alarmView).toMatch(/<Suspense fallback=\{null\}>\s*<QuerySync/);
    // 列表主体不能依赖 useSearchParams 的返回值
    expect(alarmView).not.toMatch(/const searchParams = useSearchParams\(\);\s*const urlQuery[\s\S]{0,200}alarms\.filter/);
  });

  it("QuerySync 无条件写回（清空 ?q= 时筛选必须复位）", () => {
    // 曾经的写法是 `if (urlQuery) setQuery(urlQuery)`：空串被跳过，
    // 于是「地址栏无 ?q=、列表还停在上一轮结果」。
    expect(alarmView).toMatch(/onQuery\(urlQuery\)/);
    expect(alarmView).not.toMatch(/if \(urlQuery\)/);
  });

  it("壳层的关键词同步也只占一个小组件", () => {
    const matches = shell.match(/useSearchParams\(/g) ?? [];
    expect(matches.length).toBe(1);
    expect(shell).toMatch(/<Suspense fallback=\{null\}>\s*<KeywordSync/);
  });
});
