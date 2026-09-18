import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ATTACHMENT_HINT,
  CONTRACT_ATTACHMENT_ACCEPT,
  CONTRACT_ATTACHMENT_EXTENSIONS,
  CONTACT_ATTACHMENT_ACCEPT,
  CONTACT_ATTACHMENT_EXTENSIONS,
  DOCUMENT_ATTACHMENT_EXTENSIONS,
  IMAGE_ATTACHMENT_EXTENSIONS,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENT_SIZE_LABEL,
} from "./uploadLimits";

/** 与 api/routers/projects.py 的 ALLOWED_EXT 对齐（后端 100MB 化由 BLF-1119 负责）。 */
const BACKEND_CONTRACT_EXT = [".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg"];
/** 与 api/routers/contacts.py 的 ALLOWED_EXT 对齐。 */
const BACKEND_CONTACT_EXT = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg"];

describe("附件上传限制单一来源", () => {
  it("体积上限为 100MB", () => {
    assert.equal(MAX_ATTACHMENT_SIZE, 100 * 1024 * 1024);
    assert.equal(MAX_ATTACHMENT_SIZE_LABEL, "100MB");
  });

  it("提示文案的数字完全由常量拼出", () => {
    assert.equal(
      ATTACHMENT_HINT,
      `支持 PDF / Word / Excel / 图片，单个文件不超过 ${MAX_ATTACHMENT_SIZE_LABEL}`,
    );
    assert.ok(ATTACHMENT_HINT.includes(MAX_ATTACHMENT_SIZE_LABEL));
  });

  it("白名单与后端 ALLOWED_EXT 一致且无重复", () => {
    assert.deepEqual([...CONTRACT_ATTACHMENT_EXTENSIONS], BACKEND_CONTRACT_EXT);
    assert.deepEqual([...CONTACT_ATTACHMENT_EXTENSIONS], BACKEND_CONTACT_EXT);
    for (const list of [CONTRACT_ATTACHMENT_EXTENSIONS, CONTACT_ATTACHMENT_EXTENSIONS]) {
      assert.equal(new Set(list).size, list.length, "白名单存在重复项");
      for (const ext of list) assert.match(ext, /^\.[a-z0-9]+$/, `扩展名格式不合法：${ext}`);
    }
  });

  it("accept 值由白名单生成（无空格、顺序一致）", () => {
    assert.equal(CONTRACT_ATTACHMENT_ACCEPT, BACKEND_CONTRACT_EXT.join(","));
    assert.equal(CONTACT_ATTACHMENT_ACCEPT, BACKEND_CONTACT_EXT.join(","));
    assert.ok(!CONTRACT_ATTACHMENT_ACCEPT.includes(" "));
    assert.ok(!CONTACT_ATTACHMENT_ACCEPT.includes(" "));
  });

  it("文档与图片白名单是后端可接受集合的子集（不提供必被 400 的格式）", () => {
    // 前端允许什么，用户就会选什么；一旦白名单里出现后端不接受的扩展名，
    // 用户只会看到一个没解释的失败。两个窄白名单必须都落在后端集合内。
    for (const [name, list] of [
      ["文档附件", DOCUMENT_ATTACHMENT_EXTENSIONS],
      ["图片素材", IMAGE_ATTACHMENT_EXTENSIONS],
    ] as const) {
      for (const ext of list) {
        assert.ok(
          BACKEND_CONTRACT_EXT.includes(ext),
          `${name}白名单含后端不接受的扩展名：${ext}`,
        );
      }
      assert.equal(new Set(list).size, list.length, `${name}白名单存在重复项`);
    }
    // 文档附件区要能上传需求里的三种文档类型，缺一个这条功能就不完整
    for (const ext of [".pdf", ".docx", ".xlsx"]) {
      assert.ok(DOCUMENT_ATTACHMENT_EXTENSIONS.includes(ext), `文档白名单缺 ${ext}`);
    }
  });
});
