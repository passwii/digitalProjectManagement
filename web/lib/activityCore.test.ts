import { describe, expect, it } from "vitest";
import { MIN_ACTIVITY_MS, completionDelay, routeActivityKey } from "./activityCore";

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

describe("routeActivityKey", () => {
  it("includes a non-empty query in the route key", () => {
    expect(routeActivityKey("/projects", "status=doing")).toBe("/projects?status=doing");
  });

  it("does not add a question mark for an empty query", () => {
    expect(routeActivityKey("/projects", "")).toBe("/projects");
  });
});
