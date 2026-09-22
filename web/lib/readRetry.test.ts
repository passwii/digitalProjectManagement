import assert from "node:assert/strict";
import test from "node:test";
import { getReadRetryDelay, isRetryableReadError } from "./readRetry";

test("网络错误和网关/限流状态可进入读取 retry", () => {
  assert.equal(isRetryableReadError({ name: "NetworkError" }), true);
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableReadError({ name: "HttpError", status }), true, String(status));
  }
});

test("参数、会话、权限、资源错误不进入读取 retry", () => {
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isRetryableReadError({ name: "HttpError", status }), false, String(status));
  }
  assert.equal(isRetryableReadError(new Error("响应不是 JSON")), false);
});

test("读取 retry 前五次约 1 秒，之后指数退避并封顶", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((attempt) => getReadRetryDelay(attempt, 0.5)),
    [1000, 1000, 1000, 1000, 1000, 2000, 4000, 8000, 16000, 30000],
  );
});

test("读取 retry 的随机抖动始终保持在合法范围", () => {
  assert.equal(getReadRetryDelay(0, 0), 800);
  assert.equal(getReadRetryDelay(0, 1), 1200);
  assert.equal(getReadRetryDelay(4, 0), 800);
  assert.equal(getReadRetryDelay(4, 1), 1200);
  assert.equal(getReadRetryDelay(99, 0), 24000);
  assert.equal(getReadRetryDelay(99, 1), 30000);
});
