import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const responses = vi.hoisted(() => ({
  redirect: vi.fn((url: URL) => ({
    type: "redirect",
    location: `${url.pathname}${url.search}`,
  })),
  next: vi.fn(() => ({ type: "next" })),
}));

vi.mock("next/server", () => ({ NextResponse: responses }));

import { middleware } from "../middleware";

function makeRequest(path: string): NextRequest {
  const url = new URL(`http://app.test${path}`);
  return {
    nextUrl: {
      pathname: url.pathname,
      clone: () => new URL(url.href),
    },
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

describe("Spark public entry route", () => {
  beforeEach(() => {
    responses.redirect.mockClear();
    responses.next.mockClear();
  });

  it("uses an HTTP redirect from /spark to the dashboard, preserving query parameters", () => {
    const response = middleware(makeRequest("/spark?source=demo"));

    expect(response).toEqual({
      type: "redirect",
      location: "/spark/dashboard?source=demo",
    });
    expect(responses.redirect).toHaveBeenCalledTimes(1);
  });
});
