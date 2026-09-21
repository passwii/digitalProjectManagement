// @vitest-environment jsdom
/**
 * 附件预览弹层的**真实 DOM**行为测试（BLF-1135）。
 *
 * `lib/contentPreview.test.ts` 测的是「这个文件能不能内联预览」的规则；
 * 本文件测的是**接线与生命周期**：
 *   · 图片 → 渲染 `<img>`；PDF → 由 PDF.js 子组件渲染；Word / Excel → 既不给 iframe
 *     也不给空白框，而是给出可读的下载引导；
 *   · 对象 URL 由本组件自己取、自己撤销 —— 关闭时撤销、切换附件时撤销旧的那份，
 *     且**父级传入的缩略图 URL 不受影响**（另一处漏 revoke 会让素材墙变破图）。
 *
 * 走 vitest + jsdom（与 `modalFocus.dom.vitest.test.ts` 同一个理由）：
 * 需要真实 `URL.createObjectURL` 调用记录与真实 DOM 查询。
 *
 * ⚠️ 查询用 `document` 而不是 render 的 `container`：弹层经 createPortal 挂到
 * `document.body`，不在 render 容器里，用 container 查会得到「什么都没渲染」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import AttachmentPreviewDialog from "../components/ui/AttachmentPreviewDialog";
import { HttpError, type Attachment } from "../lib/api";

// 保留真实 next/dynamic 接线；只隔离 jsdom 无法执行的 PDF canvas 渲染内核。
vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: { workerSrc: "" } },
  Document: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Page: () => <div />,
}));

const att = (id: number, filename: string, contentType = ""): Attachment => ({
  id,
  filename,
  size: 2048,
  content_type: contentType,
  uploaded_by: 1,
  uploaded_at: "2026-09-18T00:00:00Z",
});

/**
 * 造一个可断言的 loadUrl：每次返回唯一 URL，便于核对撤销的是不是同一份。
 *
 * 注意：**组件自己并不调 `createObjectURL`**——取对象 URL 是父级 `loadUrl` 的职责，
 * 弹层只负责在恰当的时机 `revokeObjectURL`。jsdom 也不实现 createObjectURL，
 * 因此这里只替身 revoke，loadUrl 直接给出确定性字符串。
 */
function makeLoader() {
  let seq = 0;
  const revoked: string[] = [];
  // jsdom 没有 revokeObjectURL 实现，先装上再替身
  URL.revokeObjectURL = () => {};
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
    revoked.push(url);
  });
  // createObjectURL 同样不存在于 jsdom；装上替身是为了断言「弹层从不自己造 blob」
  // （类型定权是父级 fetchObjectUrl 的职责，弹层只消费传进来的 URL）。
  URL.createObjectURL = () => "blob:not-expected";
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => "blob:not-expected",
  );
  const loadUrl = vi.fn(async (a: Attachment) => {
    seq += 1;
    return `blob:preview-${a.id}-${seq}`;
  });
  return { loadUrl, revoked };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("附件预览：按类型给出正确的渲染方式", () => {
  it("图片渲染 <img>，不渲染 iframe", async () => {
    const { loadUrl } = makeLoader();
    render(
      <AttachmentPreviewDialog
        attachment={att(1, "现场照片.png", "image/png")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    const img = document.querySelector("img.image-preview");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("blob:preview-1");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("PDF 交给 PDF.js 子组件渲染，不保留浏览器 iframe 预览", async () => {
    const { loadUrl } = makeLoader();
    render(
      <AttachmentPreviewDialog
        attachment={att(2, "合同扫描件.pdf", "application/pdf")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    expect(document.querySelector("section[aria-label='合同扫描件.pdf PDF 预览']")).not.toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("img.image-preview")).toBeNull();
  });

  it("PDF 的 Blob URL 由父级提供，组件自己不构造也不改写类型", async () => {
    // 安全边界在父级（`fetchObjectUrl(path, previewBlobType(a))`），不在本组件：
    // 弹层把拿到的 URL 原样交给 PDF.js，因此这里守住「不去拿原始响应头当类型」这件事 ——
    // 若哪天有人把取 URL 的逻辑挪回弹层（绕过定权），这两个断言会直接戳穿。
    const { loadUrl } = makeLoader();
    render(
      <AttachmentPreviewDialog
        attachment={att(9, "任意.pdf", "text/html")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    // 附件自称 text/html，但扩展名是 .pdf：仍然按 PDF 走 PDF.js
    expect(loadUrl).toHaveBeenCalledTimes(1);
    expect(document.querySelector("section[aria-label='任意.pdf PDF 预览']")).not.toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    // 弹层不得自己造 blob
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("Word / Excel 不给假预览：说明原因并指引下载", async () => {
    const { loadUrl } = makeLoader();
    const { getByText } = render(
      <AttachmentPreviewDialog
        attachment={att(3, "需求说明.docx")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    // 关键：绝不能给一个渲染不出内容的 iframe/空白框
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("img.image-preview")).toBeNull();
    expect(getByText(/Word \/ Excel/)).not.toBeNull();
    // 也不需要为不可预览的文件取对象 URL（白下载一次整份文件）
    expect(loadUrl).not.toHaveBeenCalled();
  });

  it("加载失败时给出可读原因，而不是空白弹层", async () => {
    const loadUrl = vi.fn(async () => "");
    const { getByText } = render(
      <AttachmentPreviewDialog
        attachment={att(4, "损坏的图片.png", "image/png")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    expect(getByText(/预览加载失败/)).not.toBeNull();
    expect(document.querySelector("img.image-preview")).toBeNull();
  });

  it("图片放大入口可聚焦，点击后进入全屏放大层，并可关闭放大层", async () => {
    const { loadUrl } = makeLoader();
    const { getByRole, queryByRole } = render(
      <AttachmentPreviewDialog
        attachment={att(11, "现场照片.png", "image/png")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});

    const trigger = getByRole("button", { name: "放大预览 现场照片.png" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(
      getByRole("dialog", { name: "现场照片.png 放大预览" }),
    ).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "关闭图片放大预览" }));
    expect(
      queryByRole("dialog", { name: "现场照片.png 放大预览" }),
    ).toBeNull();
  });

  it("放大层打开时 Escape 和附件关闭按钮都只退出放大层", async () => {
    const { loadUrl } = makeLoader();
    const onClose = vi.fn();
    const { getAllByRole, getByRole, queryByRole } = render(
      <AttachmentPreviewDialog
        attachment={att(12, "现场照片.png", "image/png")}
        loadUrl={loadUrl}
        onClose={onClose}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});

    fireEvent.click(getByRole("button", { name: "放大预览 现场照片.png" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByRole("dialog", { name: "现场照片.png 放大预览" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "放大预览 现场照片.png" }));
    fireEvent.click(getAllByRole("button", { name: "关闭" })[0]);
    expect(queryByRole("dialog", { name: "现场照片.png 放大预览" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("附件预览：失败分层（502 可重试 / 404 已丢失）", () => {
  const renderWith = (loadUrl: (a: Attachment) => Promise<string>) =>
    render(
      <AttachmentPreviewDialog
        attachment={att(10, "现场照片.png", "image/png")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );

  it("502（存储暂不可用）：说清可重试、给重试按钮，点重试后真的重取并渲染", async () => {
    let calls = 0;
    const loadUrl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new HttpError(
          502,
          '{"detail":"文件存储不可用，请稍后重试（R2 读取失败（ClientError））"}',
        );
      }
      return "blob:preview-10-retry";
    });
    const { getByText } = renderWith(loadUrl);
    await act(async () => {});

    // 与 404 的关键区别：不说「已丢失」，而是「可重试」
    expect(getByText(/存储暂不可用/)).not.toBeNull();
    expect(getByText(/可重试/)).not.toBeNull();
    expect(document.body.textContent).not.toContain("已丢失");

    const retry = getByText("重试");
    expect(retry).not.toBeNull();
    await act(async () => {
      fireEvent.click(retry);
    });
    await act(async () => {});

    expect(loadUrl).toHaveBeenCalledTimes(2);
    expect(document.querySelector("img.image-preview")?.getAttribute("src")).toBe(
      "blob:preview-10-retry",
    );
  });

  it("404（正文确实不存在）：只说已丢失，不给重试按钮", async () => {
    const loadUrl = vi.fn(async () => {
      throw new HttpError(404, '{"detail":"附件文件已丢失，请联系管理员"}');
    });
    const { getByText, queryByText } = renderWith(loadUrl);
    await act(async () => {});

    expect(getByText(/附件已丢失/)).not.toBeNull();
    expect(getByText(/请联系管理员/)).not.toBeNull();
    // 重试无效就不该给按钮：给了等于引导用户做徒劳操作
    expect(queryByText("重试")).toBeNull();
    expect(document.querySelector("img.image-preview")).toBeNull();
  });
});

describe("附件预览：对象 URL 生命周期", () => {
  it("关闭时撤销自己取回的 URL", async () => {
    const { loadUrl, revoked } = makeLoader();
    const { rerender } = render(
      <AttachmentPreviewDialog
        attachment={att(5, "图.png", "image/png")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    rerender(
      <AttachmentPreviewDialog
        attachment={null}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    expect(revoked).toContain("blob:preview-5-1");
  });

  it("切换附件时撤销旧 URL，不漏也不误伤新的那份", async () => {
    const { loadUrl, revoked } = makeLoader();
    const { rerender } = render(
      <AttachmentPreviewDialog
        attachment={att(6, "a.png", "image/png")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    rerender(
      <AttachmentPreviewDialog
        attachment={att(7, "b.png", "image/png")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    // 旧的被撤销
    expect(revoked).toContain("blob:preview-6-1");
    // 新的仍然有效（渲染中的那个 blob 不能被撤销）
    expect(revoked).not.toContain("blob:preview-7-2");
  });

  it("卸载时撤销在途取得的 URL，不泄漏", async () => {
    const { loadUrl, revoked } = makeLoader();
    const { unmount } = render(
      <AttachmentPreviewDialog
        attachment={att(8, "c.png", "image/png")}
        loadUrl={loadUrl}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );
    await act(async () => {});
    unmount();
    expect(revoked).toContain("blob:preview-8-1");
  });
});
