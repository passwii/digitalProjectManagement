import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * review 缺陷 1 的回归：`/stream-monitor` 是免登录演示站，**告警分片**也必须免登录。
 *
 * 告警中心的「加载下一页」在浏览器里直接 fetch `/stream-monitor-data/alarms/shard-*.json`。
 * 只把 `/stream-monitor` 放进 PUBLIC_PATHS 时，匿名请求会被 307 到 /login，JSON.parse
 * 拿到 HTML 报错，列表永远停在首屏 50 条 —— 逐页走查看不出来，只有点翻页才暴露。
 *
 * 另外守 BLF-1387 的改名迁移：旧路径 `/av/**` 必须 308 到新路径，位置一一对应，
 * 不留断链；且 `/avX`、`/av-foo` 这类相邻路径**不能**被当成旧站点（仍要求登录）。
 */

const responses = vi.hoisted(() => ({
  // 刻意只在调用方**显式传了**状态码时把它带进返回值：
  // 原来的断言是 `toEqual({ type: "redirect", location: "/login" })`，
  // 多一个 `status` 字段就会让整批用例红。
  redirect: vi.fn((url: URL, status?: number) => ({
    type: "redirect",
    location: `${url.pathname}${url.search}`,
    ...(status === undefined ? {} : { status }),
  })),
  next: vi.fn(() => ({ type: "next" })),
}));

vi.mock("next/server", () => ({ NextResponse: responses }));

import { middleware } from "../middleware";

function makeRequest(path: string, token?: string): NextRequest {
  const url = new URL(`http://app.test${path}`);
  return {
    nextUrl: { pathname: url.pathname, clone: () => new URL(url.href) },
    cookies: { get: (name: string) => (token && name === "pm_access_token" ? { value: token } : undefined) },
  } as unknown as NextRequest;
}

describe("智能音视频平台 免登录边界", () => {
  beforeEach(() => {
    responses.redirect.mockClear();
    responses.next.mockClear();
  });

  it("匿名请求告警数据文件不被重定向（缺陷 1 回归）", () => {
    const response = middleware(makeRequest("/stream-monitor-data/alarms/shard-000.json"));
    expect(response).toEqual({ type: "next" });
    expect(responses.redirect).not.toHaveBeenCalled();
  });

  it("匿名请求数据目录下的索引文件也放行", () => {
    for (const path of ["/stream-monitor-data/alarms-index.json", "/stream-monitor-data/index.json"]) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(path))).toEqual({ type: "next" });
    }
  });

  it("只放行数据目录，不放行相邻路径", () => {
    const response = middleware(makeRequest("/stream-monitor-data-secret/secret.json"));
    expect(response).toEqual({ type: "redirect", location: "/login" });
  });

  it("旧数据目录 /mock/av 308 到新目录，位置一一对应（不留断链）", () => {
    const cases: [string, string][] = [
      ["/mock/av", "/stream-monitor-data"],
      ["/mock/av/", "/stream-monitor-data"],
      ["/mock/av/index.json", "/stream-monitor-data/index.json"],
      ["/mock/av/alarms-index.json", "/stream-monitor-data/alarms-index.json"],
      ["/mock/av/alarms/shard-000.json", "/stream-monitor-data/alarms/shard-000.json"],
    ];
    for (const [from, to] of cases) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(from)), from).toEqual({
        type: "redirect",
        location: to,
        status: 308,
      });
    }
  });

  it("旧数据目录匹配带斜杠边界：相邻路径仍要求登录", () => {
    for (const path of ["/mock/avX", "/mock/av-foo", "/mock/avx/index.json"]) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(path)), path).toEqual({ type: "redirect", location: "/login" });
    }
  });

  it("没有 token 时 /stream-monitor 子路由照常可访问", () => {
    for (const path of [
      "/stream-monitor/overview",
      "/stream-monitor/alarm",
      "/stream-monitor/alarm/AL-00042",
      "/stream-monitor/__stress",
      "/stream-monitor/audio",
    ]) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(path)), path).toEqual({ type: "next" });
    }
  });

  it("/stream-monitor 的公开不是前缀宽松匹配：相邻路径仍要求登录", () => {
    for (const path of ["/stream-monitorX", "/stream-monitor-foo", "/stream-monitors"]) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(path)), path).toEqual({ type: "redirect", location: "/login" });
    }
  });

  it("/stream-monitor 仍重定向到总览，且保留查询串（门禁 gate=1 依赖它）", () => {
    const response = middleware(makeRequest("/stream-monitor?gate=1"));
    expect(response).toEqual({ type: "redirect", location: "/stream-monitor/overview?gate=1" });
  });

  it("旧路径 /av 及其子路径 308 到新站点，位置一一对应（不留断链）", () => {
    const cases: [string, string][] = [
      // 站点根直接指到总览页：迁移前 /av 也是一跳到 /av/overview，保持同样的一跳
      ["/av", "/stream-monitor/overview"],
      ["/av/", "/stream-monitor/overview"],
      ["/av/overview", "/stream-monitor/overview"],
      ["/av/alarm", "/stream-monitor/alarm"],
      ["/av/alarm/AL-00042", "/stream-monitor/alarm/AL-00042"],
      ["/av/event/EV-20160714", "/stream-monitor/event/EV-20160714"],
      ["/av/audio", "/stream-monitor/audio"],
      ["/av/__stress", "/stream-monitor/__stress"],
    ];
    for (const [from, to] of cases) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(from)), from).toEqual({
        type: "redirect",
        location: to,
        status: 308,
      });
    }
  });

  it("旧路径重定向保留查询串（?q= / ?gate=1 不丢）", () => {
    const response = middleware(makeRequest("/av/alarm?q=fire&gate=1"));
    expect(response).toEqual({
      type: "redirect",
      location: "/stream-monitor/alarm?q=fire&gate=1",
      status: 308,
    });
  });

  it("旧站点匹配带斜杠边界：/avX、/av-foo、/ave 仍要求登录", () => {
    for (const path of ["/avX", "/av-foo", "/ave"]) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(path)), path).toEqual({ type: "redirect", location: "/login" });
    }
  });
});
