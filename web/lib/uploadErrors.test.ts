/// <reference lib="dom" />
/**
 * 附件传输失败的分层测试（BLF-1137）。
 *
 * 断言的是**文案分支**，不触网：用后端真实响应体（`{"detail": "…"}`）构造错误，
 * 覆盖 502（存储暂不可用，可重试）/ 404（附件已丢失，不可重试）/ 400（体积类型不合规）
 * 三条分支，以及代理层 HTML 502 这条最容易退化成「泛化文案」的路径。
 *
 * 为什么要带 `/// <reference lib="dom" />`：本文件要验证 `api.ts` 抛出的错误类型，
 * 而 `api.ts` 本身依赖 `localStorage` / `XMLHttpRequest` / `document`（浏览器侧封装），
 * 而 `tsconfig.test.json` 的 `lib` 只有 ES2022。这里**只为这一个测试程序**补上 DOM 类型，
 * 不动共享配置（其余 `lib/*.test.ts` 依旧在无 DOM 的环境里编译，仍能挡住「纯逻辑模块
 * 偷偷用浏览器全局」）。运行时仍是 node，没有真实 DOM。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError, NetworkError, UnauthorizedError, UploadAbortedError, errText } from "./api";
import {
  batchFailureToast,
  classifyTransferFailure,
  extractDetail,
  failureFromResponse,
  failureLine,
  failureToast,
  splitApiMessage,
} from "./uploadErrors";

/** 后端真实错误体（`api/core/attachments.py` / `api/core/limits.py` 的原文） */
const STATUS_UNAVAILABLE = "文件存储不可用，请稍后重试（R2 上传失败（ClientError））";
const LOST = "附件文件已丢失，请联系管理员";
const SIZE_LIMIT = "单文件最大 100MB";

const json = (detail: string) => JSON.stringify({ detail });

describe("状态码 → 分层", () => {
  it("502 是「存储暂不可用」，可重试，文案体现稍后重试", () => {
    const f = failureFromResponse(502, json(STATUS_UNAVAILABLE));
    assert.equal(f.kind, "storage_unavailable");
    assert.equal(f.status, 502);
    assert.equal(f.retryable, true);
    assert.equal(f.label, "存储暂不可用");
    assert.equal(f.message, STATUS_UNAVAILABLE);
    assert.match(failureLine(f), /请稍后重试/);
    assert.match(failureLine(f), /可重试/);
    // 绝不吓成「文件丢了」
    assert.doesNotMatch(failureLine(f), /丢失/);
  });

  it("503 / 504 与 502 同档（网关侧抖动同样可重试）", () => {
    for (const status of [503, 504]) {
      const f = failureFromResponse(status, "");
      assert.equal(f.kind, "storage_unavailable", `${status} 归入存储不可用`);
      assert.equal(f.retryable, true);
    }
  });

  it("404 是「附件已丢失」，不可重试，才说联系管理员", () => {
    const f = failureFromResponse(404, json(LOST));
    assert.equal(f.kind, "file_lost");
    assert.equal(f.retryable, false);
    assert.equal(f.label, "附件已丢失");
    assert.equal(f.message, LOST);
    assert.match(failureLine(f), /请联系管理员/);
    assert.doesNotMatch(failureLine(f), /可重试/);
  });

  it("404 没有响应体时也落到「文件已丢失」兜底文案", () => {
    const f = failureFromResponse(404, "");
    assert.equal(f.message, "附件文件已丢失，请联系管理员");
    assert.equal(f.retryable, false);
  });

  it("400 是「文件不合规」，文案与后端 / uploadLimits 同一句", () => {
    const f = failureFromResponse(400, json(SIZE_LIMIT));
    assert.equal(f.kind, "invalid");
    assert.equal(f.retryable, false);
    assert.equal(f.label, "文件不合规");
    assert.equal(f.message, SIZE_LIMIT);
    assert.match(f.hint, /更换文件/);
  });

  it("413 / 415 与 400 同档（体积 / 类型不合规）", () => {
    assert.equal(failureFromResponse(413, "").kind, "invalid");
    assert.equal(failureFromResponse(415, "").kind, "invalid");
  });

  it("502 / 404 / 400 三档在 UI 上互相可分（徽标与文案都不撞）", () => {
    const tiers = [failureFromResponse(502, ""), failureFromResponse(404, ""), failureFromResponse(400, "")];
    assert.equal(new Set(tiers.map((t) => t.label)).size, 3, "三个徽标各不相同");
    assert.equal(new Set(tiers.map((t) => t.message)).size, 3, "三句文案各不相同");
    assert.deepEqual(
      tiers.map((t) => t.retryable),
      [true, false, false],
      "只有存储不可用才是可重试",
    );
  });

  it("500 归入服务端异常，同样可重试", () => {
    const f = failureFromResponse(500, "");
    assert.equal(f.kind, "server_error");
    assert.equal(f.retryable, true);
  });

  it("403 与 401 分别归入无权限与会话失效，都不给重试", () => {
    assert.equal(failureFromResponse(403, json("仅上传者或管理员可删除附件")).kind, "forbidden");
    assert.equal(failureFromResponse(403, "").retryable, false);
    assert.equal(failureFromResponse(401, "").kind, "session");
  });
});

describe("代理层 HTML 错误页不冒充后端文案", () => {
  it("502 的 HTML 响应体不会贴进 UI，而是落本地兜底文案", () => {
    const html = "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>";
    const f = failureFromResponse(502, html);
    assert.equal(f.message, "文件存储暂时不可用，请稍后重试");
    assert.doesNotMatch(f.message, /[<>]/);
    assert.equal(f.retryable, true, "代理 502 也不是「文件丢了」，仍可重试");
  });

  it("404 的 HTML 响应体同样落「文件已丢失」兜底", () => {
    const f = failureFromResponse(404, "<html>404 Not Found</html>");
    assert.equal(f.message, LOST);
    assert.doesNotMatch(f.message, /[<>]/);
  });

  it("纯文本错误体（非 JSON）可以照原样展示", () => {
    const f = failureFromResponse(400, "凭证文件为空");
    assert.equal(f.message, "凭证文件为空");
  });

  it("errText 也不再把整页 HTML 丢给用户", () => {
    assert.equal(errText(new Error("API 502: <html><body>502 Bad Gateway</body></html>")), "请求失败，请稍后重试");
  });
});

describe("异常 → 分层", () => {
  it("HttpError 用结构化状态码判定，不依赖字符串格式", () => {
    const f = classifyTransferFailure(new HttpError(502, json(STATUS_UNAVAILABLE), "Bad Gateway"));
    assert.equal(f.status, 502);
    assert.equal(f.kind, "storage_unavailable");
    assert.equal(f.message, STATUS_UNAVAILABLE);
  });

  it("HttpError 无响应体时落中文兜底文案（不用英文 statusText）", () => {
    const f = classifyTransferFailure(new HttpError(502, "", "Bad Gateway"));
    assert.equal(f.message, "文件存储暂时不可用，请稍后重试");
    assert.equal(f.label, "存储暂不可用");
    // statusText 仍用在 `Error.message` 里（兼容 errText 的旧格式），只是不当展示文案
    assert.match(new HttpError(502, "", "Bad Gateway").message, /Bad Gateway/);
  });

  it("普通 Error（形如 API 400: …）也能分层，兼容旧调用点", () => {
    const f = classifyTransferFailure(new Error(`API 400: ${json(SIZE_LIMIT)}`));
    assert.equal(f.status, 400);
    assert.equal(f.message, SIZE_LIMIT);
    assert.equal(f.retryable, false);
  });

  it("网络异常与会话失效各归各档", () => {
    const net = classifyTransferFailure(new NetworkError("无法连接后端"));
    assert.equal(net.kind, "network");
    assert.equal(net.retryable, true);
    assert.equal(net.status, null);
    assert.equal(classifyTransferFailure(new UnauthorizedError("401")).kind, "session");
  });

  it("主动取消不是失败：不标可重试，文案是「已取消」", () => {
    const f = classifyTransferFailure(new UploadAbortedError("上传已取消"));
    assert.equal(f.kind, "aborted");
    assert.equal(f.retryable, false);
    assert.equal(f.label, "已取消");
  });

  it("完全未知的异常也不会抛错，落兜底分层", () => {
    const f = classifyTransferFailure(null);
    assert.equal(f.kind, "unknown");
    assert.equal(f.message, "请求失败，请稍后重试");
    assert.equal(f.retryable, false);
  });
});

describe("响应体解析", () => {
  it("detail 为字符串 → 取它", () => {
    assert.equal(extractDetail(json("单文件最大 100MB")), "单文件最大 100MB");
  });

  it("detail 为校验错误数组 → 拼接 msg", () => {
    const body = JSON.stringify({ detail: [{ msg: "field required" }, { msg: "invalid" }] });
    assert.equal(extractDetail(body), "field required；invalid");
  });

  it("非 JSON / 空 body → 不取（交给兜底文案）", () => {
    assert.equal(extractDetail("<html>502</html>"), null);
    assert.equal(extractDetail(""), null);
  });

  it("超长 detail 虽然能解析出来，但展示层会回落到兜底文案（不把日志贴进 UI）", () => {
    const long = "啊".repeat(200);
    assert.equal(extractDetail(json(long)), long);
    const f = failureFromResponse(502, json(long));
    assert.equal(f.message, "文件存储暂时不可用，请稍后重试");
  });

  it("splitApiMessage 拆得出状态码与响应体", () => {
    assert.deepEqual(splitApiMessage(`API 502: ${json(LOST)}`), { status: 502, body: json(LOST) });
    assert.equal(splitApiMessage("其他错误"), null);
  });
});

describe("Toast 文案", () => {
  it("单条：徽标 + 文案 + 动作提示", () => {
    const text = failureToast(failureFromResponse(502, json(STATUS_UNAVAILABLE)));
    assert.match(text, /^存储暂不可用：/);
    assert.match(text, /可直接重试/);
  });

  it("整批同一原因：只报一次并指向行内「重试」", () => {
    const rows = [
      failureFromResponse(502, json(STATUS_UNAVAILABLE)),
      failureFromResponse(502, json(STATUS_UNAVAILABLE)),
      failureFromResponse(502, json(STATUS_UNAVAILABLE)),
    ];
    const text = batchFailureToast(rows);
    assert.match(text, /3 个文件上传失败（存储暂不可用）/);
    assert.match(text, /可点行内「重试」/);
  });

  it("整批原因不一：不把单条文案说成全体原因", () => {
    const text = batchFailureToast([failureFromResponse(502, ""), failureFromResponse(400, json(SIZE_LIMIT))]);
    assert.match(text, /2 个文件上传失败（多种原因）/);
    assert.doesNotMatch(text, /可点行内「重试」/);
  });

  it("空集合不产出文案", () => {
    assert.equal(batchFailureToast([]), "");
  });
});
