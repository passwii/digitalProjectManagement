import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyFailure,
  applyProgress,
  applyRetry,
  applySuccess,
  hasUploading,
  initialItems,
  removeItem,
  type UploadItem,
} from "./uploadQueueCore";
import { failureFromResponse } from "./uploadErrors";

/** 502 存储不可用（后端真实文案）：可重试 */
const FAIL_502 = failureFromResponse(
  502,
  JSON.stringify({ detail: "文件存储不可用，请稍后重试（R2 上传失败（ClientError））" }),
);
/** 404 附件已丢失：不可重试 */
const FAIL_404 = failureFromResponse(404, JSON.stringify({ detail: "附件文件已丢失，请联系管理员" }));
/** 400 体积/类型不合规：不可重试 */
const FAIL_400 = failureFromResponse(400, JSON.stringify({ detail: "单文件最大 100MB" }));

function fakeFile(name: string, size = 1024): File {
  return new File([new Uint8Array(8)], name) as File;
}

/** 进度事件对象（与 xhr.upload.onprogress 同形）。 */
function evt(loaded: number, total: number, lengthComputable = true) {
  return { loaded, total, percent: lengthComputable ? Math.round((loaded / total) * 100) : null };
}

describe("上传队列初始条目", () => {
  it("每个文件一行，起点是确定的 0% 且状态为上传中", () => {
    const rows = initialItems([fakeFile("a.pdf"), fakeFile("b.png")], [1, 2]);
    assert.deepEqual(
      rows.map((r) => ({ id: r.id, name: r.name, progress: r.progress, status: r.status })),
      [
        { id: 1, name: "a.pdf", progress: 0, status: "uploading" },
        { id: 2, name: "b.png", progress: 0, status: "uploading" },
      ],
    );
  });

  it("多文件各自独立成行（不是合并成一个总进度）", () => {
    const rows = initialItems([fakeFile("a.pdf"), fakeFile("b.pdf"), fakeFile("c.pdf")], [1, 2, 3]);
    assert.equal(rows.length, 3);
  });
});

describe("进度回调驱动条目更新", () => {
  it("只更新命中 id 的那一行，其余不受影响", () => {
    const rows = initialItems([fakeFile("a.pdf"), fakeFile("b.pdf")], [1, 2]);
    const next = applyProgress(rows, 2, evt(50, 100));
    assert.equal(next[0].progress, 0);
    assert.equal(next[1].progress, 50);
  });

  it("体积不可知（percent 为 null）时保留 null，不伪造成 0", () => {
    const rows = initialItems([fakeFile("a.pdf")], [1]);
    const next = applyProgress(rows, 1, evt(1024, 0, false));
    assert.equal(next[0].progress, null);
  });

  it("迟到的进度事件不能把已完成的条目拉回上传中", () => {
    let rows = initialItems([fakeFile("a.pdf")], [1]);
    rows = applySuccess(rows, 1);
    const late = applyProgress(rows, 1, evt(10, 100));
    assert.equal(late[0].status, "done");
    assert.equal(late[0].progress, 100);
  });

  it("失败的条目也不会被迟到进度覆盖回百分比", () => {
    let rows = initialItems([fakeFile("a.pdf")], [1]);
    rows = applyFailure(rows, 1, FAIL_400);
    const late = applyProgress(rows, 1, evt(10, 100));
    assert.equal(late[0].status, "error");
    assert.equal(late[0].progress, null);
  });
});

describe("成功 / 失败 / 取消", () => {
  it("成功把进度补满 100 并清掉残留原因", () => {
    let rows = initialItems([fakeFile("a.pdf")], [1]);
    rows = applyFailure(rows, 1, FAIL_502);
    rows = applySuccess(rows, 1);
    assert.equal(rows[0].status, "done");
    assert.equal(rows[0].progress, 100);
    assert.equal(rows[0].message, undefined);
    assert.equal(rows[0].failure, undefined, "成功后不留下上一轮的分层结果");
  });

  it("失败带可读原因且隐藏百分比（避免显示一个骗人的进度）", () => {
    const rows = applyFailure(initialItems([fakeFile("a.pdf")], [1]), 1, FAIL_400);
    assert.equal(rows[0].status, "error");
    assert.equal(rows[0].progress, null);
    assert.equal(rows[0].message, "单文件最大 100MB");
    assert.equal(rows[0].failure?.retryable, false, "400 不该给出重试入口");
  });

  it("502 的分层结果标成可重试，404 标成不可重试（UI 据此决定重试按钮）", () => {
    const rows = applyFailure(
      applyFailure(initialItems([fakeFile("a.pdf"), fakeFile("b.pdf")], [1, 2]), 1, FAIL_502),
      2,
      FAIL_404,
    );
    assert.equal(rows[0].failure?.kind, "storage_unavailable");
    assert.equal(rows[0].failure?.retryable, true);
    assert.equal(rows[0].failure?.label, "存储暂不可用");
    assert.equal(rows[1].failure?.kind, "file_lost");
    assert.equal(rows[1].failure?.retryable, false);
    assert.equal(rows[1].failure?.label, "附件已丢失");
  });

  it("一批里单个失败不影响其它行，能看出是哪一个失败", () => {
    let rows = initialItems([fakeFile("a.pdf"), fakeFile("b.pdf")], [1, 2]);
    rows = applySuccess(rows, 1);
    rows = applyFailure(rows, 2, failureFromResponse(400, JSON.stringify({ detail: "仅允许 ['.pdf']" })));
    assert.equal(rows[0].status, "done");
    assert.equal(rows[1].status, "error");
    assert.equal(rows[1].name, "b.pdf");
    assert.match(rows[1].message ?? "", /仅允许/);
  });

  it("重试把失败条目拉回上传中并清掉上一轮原因", () => {
    let rows = applyFailure(initialItems([fakeFile("a.pdf")], [1]), 1, FAIL_502);
    rows = applyRetry(rows, 1);
    assert.equal(rows[0].status, "uploading");
    assert.equal(rows[0].progress, 0);
    assert.equal(rows[0].message, undefined);
    assert.equal(rows[0].failure, undefined);
  });

  it("重试只对失败条目生效，已完成/在传的条目原样返回", () => {
    const done = applySuccess(initialItems([fakeFile("a.pdf"), fakeFile("b.pdf")], [1, 2]), 1);
    const after = applyRetry(done, 1);
    assert.equal(after[0].status, "done");
    assert.equal(after[0].progress, 100);
    const uploading = applyRetry(initialItems([fakeFile("c.pdf")], [3]), 3);
    assert.equal(uploading[0].status, "uploading");
    assert.equal(uploading[0].progress, 0);
  });

  it("取消把该行移除而不是留下一条红色失败", () => {
    const rows = removeItem(initialItems([fakeFile("a.pdf"), fakeFile("b.pdf")], [1, 2]), 1);
    assert.deepEqual(rows.map((r) => r.id), [2]);
  });
});

describe("uploading 聚合状态", () => {
  it("仍有文件在传时为 true；全部结束（完成/失败/取消）后为 false", () => {
    let rows: UploadItem[] = initialItems([fakeFile("a.pdf"), fakeFile("b.pdf")], [1, 2]);
    assert.equal(hasUploading(rows), true);
    rows = applySuccess(rows, 1);
    assert.equal(hasUploading(rows), true, "还有一个在传");
    rows = applyFailure(rows, 2, FAIL_404);
    assert.equal(hasUploading(rows), false);
  });

  it("空列表不算上传中", () => {
    assert.equal(hasUploading([]), false);
  });
});
