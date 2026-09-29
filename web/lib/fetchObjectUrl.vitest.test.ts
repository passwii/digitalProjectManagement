// @vitest-environment jsdom
/**
 * `fetchObjectUrl` 与内联预览的安全契约（BLF-1135 复验项）。
 *
 * 这是「存储型 XSS」那条链路的**接线端**测试：纯函数 `previewBlobType` 说该定权成什么类型，
 * 但真正把字节交给 `<iframe>` 的是 `fetchObjectUrl` 造出来的 blob URL。
 * 因此这里不看函数返回值，而是**拦住浏览器真实的 `URL.createObjectURL`**，
 * 断言它收到的 blob 的 `type` —— 这正是 `<iframe>` 会用来解释字节的那个字段。
 *
 * 攻击链（review 里给出）：后端只校验扩展名、`content_type` 由客户端在 multipart 里声明；
 * 于是 `任意.pdf` + `Content-Type: text/html` 能入库，下载时原样回放，
 * 前端若把这个响应头当类型，blob URL（继承创建者源，而 token 在 localStorage）里的 HTML
 * 就会以应用同源执行。本测试构造的正是这条响应，断言字节**永远不会**以 text/html 落地。
 *
 * 走 vitest + jsdom：需要真实的 `Response` / `Blob` / `URL.createObjectURL`，
 * node:test 那套 tsconfig 只有 ES2022 类型，编译不了 `api.ts` 里的 DOM 引用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchObjectUrl } from "./api";
import { previewBlobType } from "./contentPreview";

/** 后端下载接口的替身：返回「扩展名说 PDF，响应头说 HTML」这种最坏响应。 */
function stubDownloadResponse(
  fileNameDeclaredType: string,
  body = "<html>恶意</html>",
) {
  const fetchMock = vi.fn(
    async () =>
      new Response(body, {
        status: 200,
        // 响应头里的类型来自上传时的客户端声明，按威胁模型不可信
        headers: { "Content-Type": fileNameDeclaredType },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * 跨 realm 的 Blob 判定。
 *
 * 不能用 `instanceof`：判定结果取决于「全局 `Blob`」和「`Response.blob()` 产出的 Blob」
 * 是否来自同一个 realm，这在不同 node 版本下并不一致。
 */
function isBlobLike(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Blob>;
  // MediaSource 只有 readyState / sourceBuffers / duration，三个成员一个都不满足
  return (
    typeof candidate.size === "number" &&
    typeof candidate.type === "string" &&
    typeof candidate.slice === "function"
  );
}

/** 记录真实 createObjectURL 收到的每一个 blob，供断言其 type。 */
function spyOnCreateObjectURL() {
  const seen: Blob[] = [];
  // jsdom 不实现 createObjectURL，先装上再替身；入参类型跟浏览器的 `Blob | MediaSource` 对齐
  URL.createObjectURL = () => "blob:stub";
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    (obj: Blob | MediaSource) => {
      // 本用例只走 blob 分支（`fetchObjectUrl` 只可能传 blob）；MediaSource 走到这里即前提已被破坏。
      //
      // 这里**不能**写 `obj instanceof Blob`：`Response.blob()` 返回的 Blob 属于「造出这个
      // Response 的那个 realm」，而测试里的全局 `Blob` 来自 jsdom。两者是否为同一个构造器
      // 取决于 node 版本如何接线全局对象——node 26 上恰好是同一个（断言通过），node 20 上
      // 不是同一个构造器就直接失败。同一份代码在开发机和生产镜像上给出相反结果，
      // 正是加 CI 跑 node 20 才发现的。
      //
      // 改用结构判定：`size` / `type` / `slice` 三者齐全即 Blob，MediaSource 一个都没有。
      // 守卫的本意是「确认走的是 blob 分支而非 MediaSource 分支」，这一点完整保留。
      if (!isBlobLike(obj)) {
        throw new Error("createObjectURL 收到的不是 Blob");
      }
      seen.push(obj);
      return `blob:stub-${seen.length}`;
    },
  );
  // jsdom 不实现 revokeObjectURL，先装上再替身（与 attachmentPreview.dom.vitest.test.tsx 同）
  URL.revokeObjectURL = () => {};
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return seen;
}

/**
 * 按字节读回 blob 的文本。
 *
 * 逐级降级，因为**能用哪条路取决于 blob 属于哪个 realm**（见 `isBlobLike` 的说明）：
 *   1. `blob.text()`         —— 真实 Blob（浏览器 / node 内置）有；jsdom 25 的 Blob 没有
 *   2. `FileReader`          —— jsdom 的 Blob 只能这么读，是 jsdom 25 下唯一可行的一条
 *   3. `blob.arrayBuffer()`  —— 兜底
 *
 * **不要**只写 `new Response(blob).text()`：undici 不认 jsdom 的 `Blob`，会把整个对象
 * 字符串化成 `"[object Blob]"` —— 断言「看似通过」实则读的是垃圾，比红灯更危险。
 * 三条路都不可用时直接抛错，绝不静默返回一个假结果。
 */
async function readBlobAsText(blob: Blob): Promise<string> {
  const candidate = blob as unknown as {
    text?: () => Promise<string>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof candidate.text === "function") {
    return candidate.text();
  }
  if (typeof FileReader === "function") {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      try {
        reader.readAsText(blob);
      } catch (error) {
        reject(error);
      }
    });
  }
  if (typeof candidate.arrayBuffer === "function") {
    return new TextDecoder().decode(await candidate.arrayBuffer());
  }
  throw new Error(
    "无法按字节读取 blob：text / FileReader / arrayBuffer 三条路都不可用，" +
      '拒绝用 new Response(blob) 兜底（会把对象读成 "[object Blob]"）',
  );
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => "tok-123",
    removeItem: () => {},
  });
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal("window", {
    location: {
      pathname: "/projects",
      origin: "http://localhost:3001",
      assign: () => {},
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("内联预览：blob 类型由扩展名定，不听响应头", () => {
  it("声明 text/html 的 .pdf 落地时必须是 application/pdf", async () => {
    stubDownloadResponse("text/html");
    const seen = spyOnCreateObjectURL();

    const url = await fetchObjectUrl(
      "/projects/1/attachments/9/download",
      previewBlobType({ filename: "任意.pdf", content_type: "text/html" }) ??
        undefined,
    );

    expect(url).toBe("blob:stub-1");
    expect(seen).toHaveLength(1);
    // 核心断言：iframe 拿到的是 PDF 类型，一份 HTML 字节只会被交给 PDF 解析器并失败
    expect(seen[0].type).toBe("application/pdf");
    expect(seen[0].type).not.toBe("text/html");
  });

  it("声明 text/html 的 .png 落地时必须是 image/png", async () => {
    stubDownloadResponse("text/html", "<html>恶意</html>");
    const seen = spyOnCreateObjectURL();

    await fetchObjectUrl(
      "/projects/1/attachments/9/download",
      previewBlobType({ filename: "图.png", content_type: "text/html" }) ??
        undefined,
    );

    expect(seen[0].type).toBe("image/png");
  });

  it("字节不被重编码：定权只改解释方式，内容原样", async () => {
    stubDownloadResponse("text/html", "PDF-BYTES-PAYLOAD");
    const seen = spyOnCreateObjectURL();

    await fetchObjectUrl(
      "/projects/1/attachments/9/download",
      previewBlobType({ filename: "合同.pdf" }) ?? undefined,
    );

    expect(seen[0].size).toBe("PDF-BYTES-PAYLOAD".length);
    // 用 FileReader 按字节读（`blob.text()` 在 jsdom 不存在，`new Response(blob)` 会读成 "[object Blob]"）
    await expect(readBlobAsText(seen[0])).resolves.toBe("PDF-BYTES-PAYLOAD");
  });

  it("不传 type 时保持响应头原样（历史调用方不受影响）", async () => {
    stubDownloadResponse("image/png", "raw");
    const seen = spyOnCreateObjectURL();

    await fetchObjectUrl("/projects/1/attachments/9/download");

    // 未传类型 = 未走内联预览的定权路径，行为与改动前一致
    expect(seen[0].type).toBe("image/png");
  });

  it("守卫仍然拦得住 MediaSource：结构判定不是把断言放水", () => {
    // 上面那些用例换成结构判定（而非 instanceof）之后，这条锁住守卫的本意：
    // 非 Blob 对象进到 createObjectURL 必须被拒。
    // MediaSource 形状（readyState / sourceBuffers / duration，三个判定字段一个都没有）。
    const mediaSourceLike = { readyState: "open", sourceBuffers: [], duration: 0 };
    expect(isBlobLike(mediaSourceLike)).toBe(false);

    spyOnCreateObjectURL();
    // @ts-expect-error 故意传入非 Blob，复现「前提被破坏」这条分支
    expect(() => URL.createObjectURL(mediaSourceLike)).toThrow(/不是 Blob/);
  });

  it("不可内联预览的扩展名定权为 null，调用方给不出 type 时也不会误判成 HTML 预览", () => {
    // 与 page.tsx 的接线保持一致：previewBlobType 为 null 时下载路径不传 type。
    // 这些文件不进 img/iframe，所以即使响应头是 text/html 也不会被执行。
    expect(previewBlobType({ filename: "需求.docx" })).toBeNull();
    expect(previewBlobType({ filename: "台账.xlsx" })).toBeNull();
  });
});
