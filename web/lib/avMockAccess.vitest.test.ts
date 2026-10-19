import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * review 缺陷 1 的回归：`/av` 是免登录演示站，**告警分片**也必须免登录。
 *
 * 告警中心的「加载下一页」在浏览器里直接 fetch `/mock/av/alarms/shard-*.json`。
 * 只把 `/av` 放进 PUBLIC_PATHS 时，匿名请求会被 307 到 /login，JSON.parse 拿到
 * HTML 报错，列表永远停在首屏 50 条 —— 逐页走查看不出来，只有点翻页才暴露。
 */

const responses = vi.hoisted(() => ({
  redirect: vi.fn((url: URL) => ({ type: "redirect", location: `${url.pathname}${url.search}` })),
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

describe("AV 免登录边界", () => {
  beforeEach(() => {
    responses.redirect.mockClear();
    responses.next.mockClear();
  });

  it("匿名请求告警分片不被重定向（缺陷 1 回归）", () => {
    const response = middleware(makeRequest("/mock/av/alarms/shard-000.json"));
    expect(response).toEqual({ type: "next" });
    expect(responses.redirect).not.toHaveBeenCalled();
  });

  it("匿名请求 /mock/av 下的索引文件也放行", () => {
    for (const path of ["/mock/av/alarms-index.json", "/mock/av/index.json"]) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(path))).toEqual({ type: "next" });
    }
  });

  it("只放行 /mock/av，不放行 /mock 下的其它路径", () => {
    const response = middleware(makeRequest("/mock/secret.json"));
    expect(response).toEqual({ type: "redirect", location: "/login" });
  });

  it("没有 token 时 /av 子路由照常可访问", () => {
    for (const path of ["/av/overview", "/av/alarm", "/av/alarm/AL-00042", "/av/__stress", "/av/audio"]) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(path)), path).toEqual({ type: "next" });
    }
  });

  it("/av 的公开不是前缀宽松匹配：相邻路径仍要求登录", () => {
    for (const path of ["/avX", "/av-foo", "/ave"]) {
      responses.redirect.mockClear();
      expect(middleware(makeRequest(path)), path).toEqual({ type: "redirect", location: "/login" });
    }
  });

  it("/av 仍重定向到总览，且保留查询串（门禁 gate=1 依赖它）", () => {
    const response = middleware(makeRequest("/av?gate=1"));
    expect(response).toEqual({ type: "redirect", location: "/av/overview?gate=1" });
  });
});
