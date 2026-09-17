import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IMAGE_ATTACHMENT_EXTENSIONS,
  CONTRACT_ATTACHMENT_EXTENSIONS,
  CONTACT_ATTACHMENT_EXTENSIONS,
} from "./uploadLimits";
import {
  applySingleFileLimit,
  filesFromPaste,
  filesFromTransfer,
  isEditableTarget,
  isFileDrag,
  partitionFiles,
  partitionForZone,
  shouldHandlePaste,
  singleFileLimitReason,
  uploadPercent,
} from "./uploadZone";

/** 造一个最小 File（node 18+ 有全局 File，无需 DOM）。 */
function file(name: string, size = 1024, type = ""): File {
  return new File([new Uint8Array(Math.min(size, 16))], name, { type }) as File;
}

/** 只改 size 属性，避免为「超限」造 100MB 真实缓冲。 */
function withSize(f: File, size: number): File {
  Object.defineProperty(f, "size", { value: size, configurable: true });
  return f;
}

/** 造一个 kind/type/getAsFile 齐全的 DataTransferItem 替身。 */
function item(f: File, kind = "file") {
  return { kind, type: f.type, getAsFile: () => f };
}

describe("拖拽判定", () => {
  it("只有带 Files 的拖拽才算文件拖拽（拖文本不高亮）", () => {
    assert.equal(isFileDrag(["Files"]), true);
    assert.equal(isFileDrag(["text/plain"]), false);
    assert.equal(isFileDrag([]), false);
    assert.equal(isFileDrag(null), false);
  });

  it("优先用 files，为空时回退回 items 里的文件", () => {
    const a = file("a.pdf");
    const b = file("b.png");
    assert.deepEqual(filesFromTransfer({ files: [a] }), [a]);
    assert.deepEqual(filesFromTransfer({ files: [], items: [item(b)] }), [b]);
    assert.deepEqual(filesFromTransfer(null), []);
  });

  it("items 里非 file 的条目（如拖入一段文字）不产出文件", () => {
    const a = file("a.pdf");
    assert.deepEqual(
      filesFromTransfer({ files: [], items: [{ kind: "string", type: "text/plain" }, item(a)] }),
      [a],
    );
  });

  it("拖入文件夹这类拿不到 File 的条目被丢弃，不抛异常", () => {
    assert.deepEqual(
      filesFromTransfer({ files: [], items: [{ kind: "file", type: "", getAsFile: () => null }] }),
      [],
    );
  });
});

describe("拖拽准入：白名单与体积上限（拒绝不静默）", () => {
  it("非白名单类型被拒，且给出含文件名与允许类型的可读原因", () => {
    const exe = file("木马.exe");
    const { accepted, rejected } = partitionFiles([exe], CONTRACT_ATTACHMENT_EXTENSIONS);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].name, "木马.exe");
    assert.match(rejected[0].reason, /不支持的文件类型/);
    assert.match(rejected[0].reason, /木马\.exe/);
    assert.match(rejected[0].reason, /PDF/);
  });

  it("超过 100MB 上限被拒，原因里带实际体积与上限", () => {
    const big = withSize(file("超大合同.pdf"), 100 * 1024 * 1024 + 1);
    const { accepted, rejected } = partitionFiles([big], CONTRACT_ATTACHMENT_EXTENSIONS);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /文件过大/);
    assert.match(rejected[0].reason, /100MB/);
  });

  it("类型先于体积判定：非白名单的大文件报类型错误（不误导用户去压缩）", () => {
    const bigExe = withSize(file("安装包.exe"), 200 * 1024 * 1024);
    const { rejected } = partitionFiles([bigExe], CONTRACT_ATTACHMENT_EXTENSIONS);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /不支持的文件类型/);
  });

  it("恰好 100MB 通过（边界取等号允许）", () => {
    const edge = withSize(file("合同.pdf"), 100 * 1024 * 1024);
    const { accepted, rejected } = partitionFiles([edge], CONTRACT_ATTACHMENT_EXTENSIONS);
    assert.deepEqual(rejected, []);
    assert.equal(accepted.length, 1);
  });

  it("无扩展名与伪造双扩展名都按最后一段判定", () => {
    const noExt = file("README");
    const fake = file("简历.pdf.exe");
    const ok = file("简历.pdf");
    const { accepted, rejected } = partitionFiles(
      [noExt, fake, ok],
      CONTRACT_ATTACHMENT_EXTENSIONS,
    );
    assert.deepEqual(accepted.map((f) => f.name), ["简历.pdf"]);
    assert.deepEqual(rejected.map((r) => r.name), ["README", "简历.pdf.exe"]);
  });

  it("混合一批时逐文件独立判定：好的放行、坏的带原因", () => {
    const rows = [file("a.pdf"), file("b.exe"), file("c.png")];
    const { accepted, rejected } = partitionFiles(rows, CONTRACT_ATTACHMENT_EXTENSIONS);
    assert.deepEqual(accepted.map((f) => f.name), ["a.pdf", "c.png"]);
    assert.deepEqual(rejected.map((r) => r.name), ["b.exe"]);
  });

  it("各入口白名单不同：.doc 在人员档案可用、在合同附件被拒", () => {
    const doc = file("旧版合同.doc");
    assert.equal(partitionFiles([doc], CONTRACT_ATTACHMENT_EXTENSIONS).rejected.length, 1);
    assert.equal(partitionFiles([doc], CONTACT_ATTACHMENT_EXTENSIONS).rejected.length, 0);
  });

  it("白板图片只放行后端真正接受的三种图片格式", () => {
    const gif = file("动图.gif", 1024, "image/gif");
    const { accepted, rejected } = partitionFiles([gif], IMAGE_ATTACHMENT_EXTENSIONS);
    assert.equal(accepted.length, 0);
    assert.match(rejected[0].reason, /不支持的文件类型/);
  });
});

describe("粘贴：不得劫持页面级 paste", () => {
  const zone = (children: unknown[] = []) => ({
    contains: (node: unknown) => children.includes(node),
  });

  it("只取图片条目；纯文本/HTML 粘贴不产出文件（因此不会触发上传）", () => {
    assert.deepEqual(filesFromPaste({ items: [{ kind: "string", type: "text/html" }] }), []);
    assert.deepEqual(filesFromPaste({ items: [{ kind: "string", type: "text/plain" }] }), []);
    assert.deepEqual(filesFromPaste({ items: [] }), []);
  });

  it("截图（image/* 的 file 条目）被取出", () => {
    const shot = file("截图.png", 2048, "image/png");
    assert.deepEqual(filesFromPaste({ items: [item(shot)] }), [shot]);
  });

  it("kind=file 但非图片（如复制的 pdf）不算截图", () => {
    const pdf = file("a.pdf", 1024, "application/pdf");
    assert.deepEqual(filesFromPaste({ items: [item(pdf)] }), []);
  });

  it("识别输入框/文本域/contenteditable 为可编辑目标", () => {
    assert.equal(isEditableTarget({ tagName: "INPUT", type: "text" }), true);
    // 没写 type 的 input 默认是文本输入
    assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
    assert.equal(isEditableTarget({ tagName: "TEXTAREA" }), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: false }), false);
    assert.equal(isEditableTarget(null), false);
  });

  it("非文本类 input 不算可编辑（上传区自己的 file input 不阻断粘贴）", () => {
    assert.equal(isEditableTarget({ tagName: "INPUT", type: "file" }), false);
    assert.equal(isEditableTarget({ tagName: "INPUT", type: "checkbox" }), false);
    assert.equal(isEditableTarget({ tagName: "INPUT", type: "radio" }), false);
    assert.equal(isEditableTarget({ tagName: "INPUT", type: "button" }), false);
  });

  it("文本类 input 仍算可编辑（区内粘贴不抢输入焦点）", () => {
    for (const type of ["text", "search", "email", "password", "number", "url", "date"]) {
      assert.equal(isEditableTarget({ tagName: "INPUT", type }), true, `${type} 应视为可编辑`);
    }
  });

  it("隐藏 file input 拿到焦点时，粘贴仍由上传区接管", () => {
    const fileInput = { tagName: "INPUT", type: "file" };
    assert.equal(shouldHandlePaste(fileInput, zone([fileInput])), true);
  });

  it("焦点在文本输入框内时即使位于上传区也不接管", () => {
    const input = { tagName: "INPUT", type: "text" };
    assert.equal(shouldHandlePaste(input, zone([input])), false);
  });

  it("contenteditable 内粘贴也不接管", () => {
    const box = { tagName: "DIV", isContentEditable: true };
    assert.equal(shouldHandlePaste(box, zone([box])), false);
  });

  it("事件目标在上传区外时不接管（页面别处粘贴不受影响）", () => {
    const outside = { tagName: "DIV" };
    assert.equal(shouldHandlePaste(outside, zone([])), false);
  });

  it("目标在上传区内且非可编辑时才接管", () => {
    const target = { tagName: "DIV" };
    assert.equal(shouldHandlePaste(target, zone([target])), true);
  });

  it("没有 zone（组件未挂载）时一律不接管", () => {
    const target = { tagName: "DIV" };
    assert.equal(shouldHandlePaste(target, null), false);
    assert.equal(shouldHandlePaste(target, {}), false);
  });
});

describe("单附件入口：多文件不得静默丢弃", () => {
  it("只放行第 1 个，其余合成一条可读提示", () => {
    const rows = [file("a.pdf"), file("b.png"), file("c.jpg")];
    const { accepted, rejected } = applySingleFileLimit(rows);
    assert.deepEqual(accepted.map((f) => f.name), ["a.pdf"]);
    assert.equal(rejected.length, 1);
    // 提示必须说清「有几个被忽略了」，只写「不支持」等于把问题藏起来
    assert.match(rejected[0].reason, /仅支持 1 个/);
    assert.match(rejected[0].reason, /2/);
  });

  it("0 个 / 1 个是常态路径：不产出任何提示", () => {
    assert.deepEqual(applySingleFileLimit([]), { accepted: [], rejected: [] });
    const one = applySingleFileLimit([file("a.pdf")]);
    assert.deepEqual(one.accepted.map((f) => f.name), ["a.pdf"]);
    assert.deepEqual(one.rejected, []);
  });

  it("6 个文件只提示被忽略的 5 个，不误报总数", () => {
    const rows = Array.from({ length: 6 }, (_, i) => file(`f${i}.pdf`));
    const { accepted, rejected } = applySingleFileLimit(rows);
    assert.equal(accepted.length, 1);
    assert.match(rejected[0].reason, /其余 5 个/);
  });

  it("多文件入口不受影响：applySingleFileLimit 只在单附件路径被调用", () => {
    // 契约断言：多文件入口走的就是 partitionFiles，7 个合规文件全部放行
    const rows = Array.from({ length: 7 }, (_, i) => file(`f${i}.png`));
    assert.equal(partitionFiles(rows, IMAGE_ATTACHMENT_EXTENSIONS).accepted.length, 7);
  });

  it("先切分再裁剪：类型不合法的文件不会白占唯一名额", () => {
    // 若调用顺序反过来，这里会变成「a.exe 占了名额 → a.pdf 报超量」，
    // 正确行为是「a.exe 报类型 → a.pdf 正常上传」
    const rows = [file("a.exe"), file("a.pdf")];
    const partitioned = partitionFiles(rows, CONTRACT_ATTACHMENT_EXTENSIONS);
    const { accepted, rejected } = applySingleFileLimit(partitioned.accepted);
    assert.deepEqual(accepted.map((f) => f.name), ["a.pdf"]);
    assert.deepEqual(rejected, []);
    assert.equal(partitioned.rejected.length, 1);
    assert.match(partitioned.rejected[0].reason, /不支持的文件类型/);
  });

  it("拒绝文案由文件数推导，不硬编码数字", () => {
    assert.match(singleFileLimitReason(1), /其余 1 个/);
    assert.match(singleFileLimitReason(4), /其余 4 个/);
  });
});

describe("上传区准入：单附件入口收到多文件时必须给出可读反馈", () => {
  // 回归的是线上缺陷 BLF-1124：人员档案附件入口 multiple={false}，
  // 但拖拽/粘贴绕过原生 input 的 multiple，调用方只取 picked[0]，
  // 导致「拖了 3 个只传 1 个、无任何提示」。

  it("multiple=false 收到 3 个合规文件：只放行 1 个，其余带提示而非静默丢弃", () => {
    const rows = [file("身份证.png"), file("学历.pdf"), file("合同.pdf")];
    const { accepted, rejected } = partitionForZone(rows, CONTACT_ATTACHMENT_EXTENSIONS, false);
    assert.deepEqual(accepted.map((f) => f.name), ["身份证.png"]);
    // 关键断言：不能是静默丢弃，必须有一条可展示的拒绝提示
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /仅支持 1 个/);
    assert.match(rejected[0].reason, /其余 2 个/);
  });

  it("multiple=false 收到 1 个：正常放行，不该出现任何提示", () => {
    const { accepted, rejected } = partitionForZone([file("a.pdf")], CONTACT_ATTACHMENT_EXTENSIONS, false);
    assert.deepEqual(accepted.map((f) => f.name), ["a.pdf"]);
    assert.deepEqual(rejected, []);
  });

  it("multiple=false 且首个文件不合法：不合法文件不得占掉唯一名额", () => {
    // 先校验后裁剪：a.exe 因类型被拒，a.pdf 仍应拿到那一个名额
    const { accepted, rejected } = partitionForZone(
      [file("a.exe"), file("a.pdf")],
      CONTRACT_ATTACHMENT_EXTENSIONS,
      false,
    );
    assert.deepEqual(accepted.map((f) => f.name), ["a.pdf"]);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /不支持的文件类型/);
  });

  it("multiple=false 且首个不合法 + 还有多文件：类型与超量两条提示都要出现", () => {
    const { accepted, rejected } = partitionForZone(
      [file("a.exe"), file("a.pdf"), file("b.pdf")],
      CONTRACT_ATTACHMENT_EXTENSIONS,
      false,
    );
    assert.deepEqual(accepted.map((f) => f.name), ["a.pdf"]);
    assert.equal(rejected.length, 2);
    assert.match(rejected.map((r) => r.reason).join("|"), /不支持的文件类型/);
    assert.match(rejected.map((r) => r.reason).join("|"), /仅支持 1 个/);
  });

  it("multiple=true（另外 3 个多文件入口）行为不变：全部合规文件逐个放行", () => {
    const rows = [file("a.pdf"), file("b.pdf"), file("c.pdf"), file("d.pdf")];
    const { accepted, rejected } = partitionForZone(rows, CONTRACT_ATTACHMENT_EXTENSIONS, true);
    assert.deepEqual(accepted.map((f) => f.name), ["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
    assert.deepEqual(rejected, []);
  });

  it("multiple=true 仍逐文件独立判定：好的放行、坏的带原因，各自不互相影响", () => {
    const rows = [file("a.pdf"), file("b.exe"), file("c.png")];
    const { accepted, rejected } = partitionForZone(rows, CONTRACT_ATTACHMENT_EXTENSIONS, true);
    assert.deepEqual(accepted.map((f) => f.name), ["a.pdf", "c.png"]);
    assert.deepEqual(rejected.map((r) => r.name), ["b.exe"]);
  });
});

describe("上传进度百分比", () => {
  it("按已发送字节换算并四舍五入", () => {
    assert.equal(uploadPercent(0, 200), 0);
    assert.equal(uploadPercent(50, 200), 25);
    assert.equal(uploadPercent(1, 3), 33);
    assert.equal(uploadPercent(200, 200), 100);
  });

  it("体积不可知时返回 null（调用方渲染不确定态，而不是伪造 0%）", () => {
    assert.equal(uploadPercent(1024, 0, false), null);
    assert.equal(uploadPercent(1024, 0), null);
    assert.equal(uploadPercent(1024, Number.NaN), null);
  });

  it("越界输入被夹到 0–100，不把异常值透给 UI", () => {
    assert.equal(uploadPercent(300, 200), 100);
    assert.equal(uploadPercent(-5, 200), 0);
  });
});
