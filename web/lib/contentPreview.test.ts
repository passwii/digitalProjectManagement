import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canPreviewInline,
  fileTypeLabel,
  isImageAttachment,
  previewBlobType,
  previewKindOf,
  previewUnsupportedText,
  type PreviewableAttachment,
} from "./contentPreview";

const att = (filename: string, content_type = ""): PreviewableAttachment => ({ filename, content_type });

describe("附件预览归类", () => {
  it("图片按扩展名归为可内联预览", () => {
    for (const name of ["现场照片.png", "扫描件.JPG", "示意图.jpeg"]) {
      assert.equal(previewKindOf(att(name)), "image", name);
      assert.equal(canPreviewInline(att(name)), true, name);
    }
  });

  it("content_type 是 image/* 时即使扩展名陌生也按图片处理", () => {
    assert.equal(isImageAttachment(att("无扩展名", "image/png")), true);
    assert.equal(previewKindOf(att("奇怪的后缀.avif", "image/avif")), "image");
  });

  it("PDF 可内联预览，Word / Excel 归为需下载", () => {
    assert.equal(previewKindOf(att("合同.pdf")), "pdf");
    assert.equal(canPreviewInline(att("合同.pdf")), true);
    for (const name of ["需求.docx", "台账.xlsx", "旧表.xls", "说明.doc"]) {
      assert.equal(previewKindOf(att(name)), "office", name);
      assert.equal(canPreviewInline(att(name)), false, name);
    }
  });

  it("未知类型既不预览也不冒充 office 提示", () => {
    assert.equal(previewKindOf(att("归档.zip")), "other");
    assert.equal(previewKindOf(att("无后缀文件")), "other");
    assert.equal(canPreviewInline(att("无后缀文件")), false);
    assert.match(previewUnsupportedText(att("归档.zip")), /该格式暂不支持在线预览/);
    assert.match(previewUnsupportedText(att("需求.docx")), /Word \/ Excel/);
  });

  it("大小写与多点文件名都取最后一段扩展名", () => {
    assert.equal(previewKindOf(att("2026.09 月报.DOCX")), "office");
    assert.equal(fileTypeLabel(att("2026.09 月报.DOCX")), "DOCX");
    assert.equal(fileTypeLabel(att("无后缀文件")), "FILE");
  });
});

describe("内联预览的 blob MIME 由扩展名定权", () => {
  it("PDF 一律强制 application/pdf，不看 content_type", () => {
    // 关键回归：上传时客户端可声明 content_type，而扩展名是后端白名单唯一校验过的一项。
    // 扩展名说 PDF、type 说 HTML 时，若听 type，字节就会在 <iframe> 里以同源 HTML 执行。
    assert.equal(previewBlobType(att("任意.pdf", "text/html")), "application/pdf");
    assert.equal(previewBlobType(att("合同.pdf", "application/octet-stream")), "application/pdf");
    assert.equal(previewBlobType(att("合同.PDF", "image/png")), "application/pdf");
    assert.equal(previewBlobType(att("合同.pdf")), "application/pdf");
  });

  it("图片按扩展名给出对应 MIME，不信任 content_type", () => {
    assert.equal(previewBlobType(att("图.png", "text/html")), "image/png");
    assert.equal(previewBlobType(att("图.JPG", "text/html")), "image/jpeg");
    assert.equal(previewBlobType(att("图.jpeg")), "image/jpeg");
    assert.equal(previewBlobType(att("图.svg", "text/html")), "image/svg+xml");
  });

  it("不可内联预览或扩展名不认识时不强制定权", () => {
    // 这些文件本来就不进 img/iframe，没必要（也不应该）偷偷改写它们的类型。
    for (const name of ["需求.docx", "台账.xlsx", "归档.zip", "无后缀文件", "奇怪的后缀.avif"]) {
      assert.equal(previewBlobType(att(name, "text/html")), null, name);
    }
  });

  it("原型链上的键不会泄漏成 MIME", () => {
    // 用 Map 而非对象字面量：后者 `MIME[ext]` 会命中原型链。
    for (const name of ["名字.constructor", "名字.toString", "名字.__proto__"]) {
      assert.equal(previewBlobType(att(name)), null, name);
    }
  });

  it("可与 canPreviewInline 对齐：能内联预览的 PDF/图片都有定权结论", () => {
    // 两个函数分别管「给不给入口」与「进来的字节算什么类型」，
    // 对可内联预览的常见格式不允许前者 true 而后者 null（会让同源执行面又回来）。
    for (const name of ["图.png", "图.jpg", "图.jpeg", "扫描件.pdf"]) {
      const a = att(name, "text/html");
      assert.equal(canPreviewInline(a), true, name);
      assert.ok(previewBlobType(a), `${name} 可内联预览却没有强制 MIME`);
    }
  });
});
