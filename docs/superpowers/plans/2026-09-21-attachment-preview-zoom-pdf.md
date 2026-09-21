# 附件预览放大与 PDF.js 渲染实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改业务页面接入方式的前提下，让公共附件预览组件支持图片全屏放大和 PDF.js 多页渲染、缩放。

**Architecture:** 保留 `AttachmentPreviewDialog` 现有的 R2 Blob URL、失败分层、重试、下载和 URL 回收职责；新增只在客户端加载的 `PdfPreview` 子组件，由 React-PDF/PDF.js 负责 PDF 页面绘制。图片放大使用公共组件内部的固定定位 lightbox，不引入新的业务层 API。

**Tech Stack:** Next.js 14 App Router、React 18.3、TypeScript、`react-pdf@9.2.1`、PDF.js worker、Vitest、Testing Library、Node test。

## Global Constraints

- 保持 `AttachmentPreviewDialog` 的业务接口：`attachment`、`loadUrl`、`onClose`、`onDownload`。
- PDF 通过现有 `fetchObjectUrl(path, previewBlobType(attachment))` 取得 Blob URL，不新增后端接口或数据库字段。
- 图片和 PDF 的 Blob MIME 继续由扩展名定权，不使用不可信的下载响应 `Content-Type`。
- PDF worker 必须只在客户端配置，并与使用 `Document` / `Page` 的模块处于同一模块执行上下文。
- Word / Excel 继续显示下载引导，不增加在线编辑或在线预览。
- React-PDF 选择兼容当前 React 18 的 9.x 版本，锁定为 `9.2.1`，不升级 React 主版本。
- 每个任务先补失败测试，再写最小实现；完成任务后运行对应验证并提交中文 commit。

---

### Task 1: 固定 React-PDF 依赖

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`

**Interfaces:**
- Produces: 可由客户端 `PdfPreview` 导入的 `react-pdf@9.2.1`，以及其锁定的 `pdfjs-dist` 依赖。

- [ ] **Step 1: 添加精确版本依赖**

在 `web/package.json` 的 `dependencies` 中加入：

```json
"react-pdf": "9.2.1"
```

- [ ] **Step 2: 安装并更新锁文件**

Run: `npm install --save-exact react-pdf@9.2.1`

Expected: `package.json` 使用 `9.2.1`，`package-lock.json` 记录 `react-pdf` 与 `pdfjs-dist`，命令退出码为 0。

- [ ] **Step 3: 检查 React peer dependency**

Run: `npm ls react-pdf pdfjs-dist react`

Expected: `react-pdf@9.2.1`、`react@18.3.1` 无 invalid peer dependency。

- [ ] **Step 4: 提交依赖变更**

```bash
git add web/package.json web/package-lock.json
git commit -m "构建：加入 React PDF 预览依赖"
```

### Task 2: 为图片放大和 PDF.js 页面渲染编写失败测试

**Files:**
- Modify: `web/lib/attachmentPreview.dom.vitest.test.tsx`
- Create: `web/lib/pdfPreview.dom.vitest.test.tsx`

**Interfaces:**
- Consumes: `AttachmentPreviewDialog` 的现有 props。
- Produces: `PdfPreview` 的测试约定：接受 `{ url, filename, onRetry }`，渲染 PDF.js `Document` / `Page`，并在加载成功后生成页数对应的页面。

- [ ] **Step 1: 写图片放大失败测试**

在 `web/lib/attachmentPreview.dom.vitest.test.tsx` 增加测试，验证图片加载后点击图片触发放大层，点击关闭按钮后放大层消失：

```tsx
it("点击图片后进入全屏放大层，并可关闭放大层", async () => {
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

  fireEvent.click(document.querySelector("img.image-preview")!);
  expect(getByRole("dialog", { name: "现场照片.png 放大预览" })).not.toBeNull();

  fireEvent.click(getByRole("button", { name: "关闭图片放大预览" }));
  expect(queryByRole("dialog", { name: "现场照片.png 放大预览" })).toBeNull();
});
```

- [ ] **Step 2: 写 PDF.js 子组件失败测试**

创建 `web/lib/pdfPreview.dom.vitest.test.tsx`，用测试替身隔离 PDF.js 画布实现，只验证公共子组件的页面和缩放契约：

```tsx
// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PdfPreview from "../components/ui/PdfPreview";

vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: { workerSrc: "" } },
  Document: ({ file, children, onLoadSuccess, onLoadError }: {
    file?: string;
    children: ReactNode;
    onLoadSuccess?: (v: { numPages: number }) => void;
    onLoadError?: (error: Error) => void;
  }) => {
    useEffect(() => {
      if (String(file).includes("error")) onLoadError?.(new Error("parse error"));
      else onLoadSuccess?.({ numPages: 2 });
    }, [file, onLoadError, onLoadSuccess]);
    return <div data-testid="pdf-document">{children}</div>;
  },
  Page: ({ pageNumber, width }: { pageNumber: number; width?: number }) => (
    <div data-testid={`pdf-page-${pageNumber}`} data-width={width} />
  ),
}));

afterEach(() => vi.clearAllMocks());

describe("PDF 公共预览", () => {
  it("加载页数后渲染全部页面，并可改变缩放比例", async () => {
    const { getByRole, getByTestId } = render(
      <PdfPreview url="blob:pdf-1" filename="合同.pdf" onRetry={() => {}} />,
    );
    await act(async () => {});
    expect(getByTestId("pdf-page-1")).not.toBeNull();
    expect(getByTestId("pdf-page-2")).not.toBeNull();
    const before = getByTestId("pdf-page-1").getAttribute("data-width");
    fireEvent.click(getByRole("button", { name: "放大 PDF" }));
    expect(getByTestId("pdf-page-1").getAttribute("data-width")).not.toBe(before);
  });

  it("PDF 解析失败时显示错误并提供重试入口", async () => {
    const onRetry = vi.fn();
    const { getByText, getByRole } = render(
      <PdfPreview url="blob:pdf-error" filename="合同.pdf" onRetry={onRetry} />,
    );
    await act(async () => {});
    expect(getByText("PDF 加载失败")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
```

测试替身通过 `blob:pdf-error` 触发 `onLoadError`，断言页面出现“PDF 加载失败”和“重试”。测试先运行，必须因 `PdfPreview` 尚未创建/接口尚未实现而失败。

- [ ] **Step 3: 运行失败测试确认是预期失败**

Run: `npm run test:motion -- lib/attachmentPreview.dom.vitest.test.tsx lib/pdfPreview.dom.vitest.test.tsx`

Expected: 新增放大测试和 PDF 测试失败，失败原因是目标交互/`PdfPreview` 尚未实现；现有其他动效测试不因语法错误而失败。

### Task 3: 创建客户端 PDF.js 预览子组件

**Files:**
- Create: `web/components/ui/PdfPreview.tsx`

**Interfaces:**
- Consumes: `url: string`、`filename: string`、`onRetry: () => void`。
- Produces: PDF 多页纵向渲染、页数状态、缩放按钮、解析错误状态；由 `AttachmentPreviewDialog` 动态加载，避免 Next.js 服务端导入 React-PDF。

- [ ] **Step 1: 配置 worker 并实现最小 Document/Page 渲染**

文件顶部在使用 `Document` / `Page` 的同一模块配置 worker：

```tsx
"use client";

import { useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();
```

组件维护 `numPages`、`scale`、`error` 和 `attempt`；加载成功后从 1 到 `numPages` 映射 `Page`，每个页面使用 `renderTextLayer={false}` 和 `renderAnnotationLayer={false}`，避免引入未配置的额外层样式。

- [ ] **Step 2: 加入 PDF 工具栏和错误状态**

工具栏按钮固定为：

```tsx
<button type="button" aria-label="缩小 PDF" onClick={() => setScale((value) => Math.max(0.75, value - 0.25))}>−</button>
<span>{numPages ? `${numPages} 页` : "正在加载 PDF…"}</span>
<button type="button" aria-label="放大 PDF" onClick={() => setScale((value) => Math.min(2.5, value + 0.25))}>＋</button>
<button type="button" aria-label="重置 PDF 缩放" onClick={() => setScale(1)}>适应宽度</button>
```

`onLoadError` 时显示 `PDF 加载失败` 和“重试”按钮；点击重试调用 `onRetry`，由父组件重新取 Blob URL。

- [ ] **Step 3: 运行 PDF 子组件测试确认通过**

Run: `npm run test:motion -- lib/pdfPreview.dom.vitest.test.tsx`

Expected: 页面数、缩放按钮和错误状态测试通过。

- [ ] **Step 4: 提交 PDF 子组件**

```bash
git add web/components/ui/PdfPreview.tsx web/lib/pdfPreview.dom.vitest.test.tsx
git commit -m "功能：增加 PDF.js 公共预览组件"
```

### Task 4: 将公共附件弹层切换到 PDF.js 并加入图片放大

**Files:**
- Modify: `web/components/ui/AttachmentPreviewDialog.tsx`
- Modify: `web/lib/attachmentPreview.dom.vitest.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `PdfPreview` props。
- Produces: 所有现有业务页面自动获得图片放大和 PDF.js 预览；既有 `AttachmentPreviewDialog` props 不变。

- [ ] **Step 1: 动态加载 PDF 子组件**

在公共弹层中使用 Next 动态导入：

```tsx
const PdfPreview = dynamic(() => import("./PdfPreview"), {
  ssr: false,
  loading: () => <div className="preview-note" role="status">正在加载 PDF 预览…</div>,
});
```

PDF 分支替换原有 iframe：

```tsx
{inline && !failure && url && kind === "pdf" && (
  <PdfPreview
    key={`${attachment.id}-${attempt}`}
    url={url}
    filename={attachment.filename}
    onRetry={() => setAttempt((value) => value + 1)}
  />
)}
```

删除 `iframe.preview-frame` 渲染路径，但保留图片、Word/Excel 和取 URL 失败路径。

- [ ] **Step 2: 加入图片放大状态和可访问交互**

使用 `imageZoomed` 状态和统一关闭函数：

```tsx
const [imageZoomed, setImageZoomed] = useState(false);
const closeDialog = () => {
  if (imageZoomed) {
    setImageZoomed(false);
    return;
  }
  onClose();
};
```

普通图片使用按钮包装，支持鼠标点击和键盘焦点；放大层使用 `role="dialog"`、`aria-modal="true"`、关闭按钮、遮罩点击关闭和 `closeDialog` 处理 Escape：

```tsx
<button type="button" className="image-preview-trigger" aria-label={`放大预览 ${attachment.filename}`} onClick={() => setImageZoomed(true)}>
  <img className="image-preview" src={url} alt={attachment.filename} />
</button>
{imageZoomed && (
  <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`${attachment.filename} 放大预览`} onClick={() => setImageZoomed(false)}>
    <button type="button" className="image-lightbox-close" aria-label="关闭图片放大预览" onClick={() => setImageZoomed(false)}>关闭</button>
    <img className="image-lightbox-image" src={url} alt={attachment.filename} onClick={(event) => event.stopPropagation()} />
  </div>
)}
```

附件变更和弹层关闭时执行 `setImageZoomed(false)`，防止下一份附件继承放大状态。

- [ ] **Step 3: 运行组件测试确认通过**

Run: `npm run test:motion -- lib/attachmentPreview.dom.vitest.test.tsx lib/pdfPreview.dom.vitest.test.tsx`

Expected: 图片放大、PDF 多页、PDF 错误重试、Word/Excel 引导和 Blob URL 生命周期测试全部通过；不再要求 `iframe` 存在。

- [ ] **Step 4: 提交公共组件改造**

```bash
git add web/components/ui/AttachmentPreviewDialog.tsx web/lib/attachmentPreview.dom.vitest.test.tsx
git commit -m "功能：支持附件图片放大与 PDF 预览"
```

### Task 5: 增加预览样式并完成回归验证

**Files:**
- Modify: `web/app/globals.css`
- Modify: `web/lib/projectContractPreview.test.ts`（仅在共享组件导入契约需要更新时）

**Interfaces:**
- Consumes: Task 4 的 CSS class：`image-preview-trigger`、`image-lightbox`、`image-lightbox-close`、`image-lightbox-image`、`pdf-preview`、`pdf-preview-toolbar`、`pdf-preview-pages`、`pdf-preview-page`。
- Produces: 桌面和移动端可用的图片放大层、PDF 页面滚动容器和工具栏样式。

- [ ] **Step 1: 添加图片放大层样式**

将以下样式加入 `web/app/globals.css`，保证放大层覆盖公共 Dialog 且图片不变形：

```css
.image-preview-trigger { display: block; width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.image-lightbox { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 5vh 4vw; background: rgba(8, 20, 34, .9); }
.image-lightbox-image { max-width: 92vw; max-height: 88vh; object-fit: contain; cursor: zoom-out; }
.image-lightbox-close { position: absolute; top: 18px; right: 22px; padding: 8px 12px; border: 1px solid rgba(255,255,255,.32); border-radius: 6px; background: rgba(0,0,0,.35); color: #fff; }
```

- [ ] **Step 2: 添加 PDF 工具栏和页面样式**

```css
.pdf-preview { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.pdf-preview-toolbar { display: flex; align-items: center; justify-content: center; gap: 8px; position: sticky; top: 0; z-index: 1; padding: 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--card); }
.pdf-preview-pages { max-height: 68vh; overflow: auto; padding: 4px; background: var(--th-bg); }
.pdf-preview-page { display: flex; justify-content: center; margin: 0 auto 12px; }
.pdf-preview-page canvas { display: block; max-width: 100%; height: auto !important; box-shadow: 0 2px 8px rgba(15,39,66,.12); }
```

- [ ] **Step 3: 跑完整前端验证**

Run: `npm run test:unit`

Expected: Node test 0 failures，包含项目合同预览和公共组件复用契约。

Run: `npm run test:motion`

Expected: 所有 DOM/motion test 通过，包含新增图片放大与 PDF.js 测试。

Run: `npm run build`

Expected: Next.js production build exit 0；允许已有 lint warning，但不得出现 React-PDF worker、SSR、TypeScript 或 webpack error。

Run: `python -m compileall -q api tests scripts && git diff --check`

Expected: exit 0。

- [ ] **Step 4: 提交样式和验证相关变更**

```bash
git add web/app/globals.css web/lib/projectContractPreview.test.ts
git commit -m "样式：完善附件预览放大与 PDF 工具栏"
```

### Task 6: 推送并部署 VPS

**Files:**
- No source files; deploy the commits from Tasks 1–5.

**Interfaces:**
- Consumes: 本地 `main` 上所有中文提交和现有 VPS 生产专用提交。
- Produces: VPS `/opt/pm` 运行最新公共附件预览组件，API/Web 容器健康。

- [ ] **Step 1: 检查本地工作区并推送**

Run: `git status --short --branch && git push origin HEAD:main`

Expected: 工作区无未提交源码变更，远端 `main` 更新成功。

- [ ] **Step 2: 保留 VPS 生产专用提交**

Run: `ssh -o BatchMode=yes -o ConnectTimeout=20 root@145.79.143.98 'cd /opt/pm && git fetch origin main && git merge-tree --write-tree HEAD origin/main >/dev/null'`

If there is no conflict, run:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=20 root@145.79.143.98 'cd /opt/pm && git merge --no-ff --no-edit origin/main'
```

- [ ] **Step 3: 执行标准部署脚本**

Run: `python scripts/deploy_vps.py`

Expected: Docker Web/API 镜像构建完成，`pm-api-1` healthy，`pm-web-1` running，健康检查返回 `{"ok":true,"storage_backend":"r2","storage_bucket":"ziktech"}`。

- [ ] **Step 4: 核对线上迁移、提交和容器**

Run:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=20 root@145.79.143.98 'cd /opt/pm && git status --short --branch && git log -1 --oneline && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api sh -lc "cd /app/api && alembic current"'
ssh -o BatchMode=yes -o ConnectTimeout=20 root@145.79.143.98 'curl -fsS http://127.0.0.1:8001/health && printf "\n" && cd /opt/pm && docker compose -f docker-compose.yml -f docker-compose.prod.yml ps'
```

Expected: VPS 工作区 clean，迁移保持 `0024_opportunities (head)`，API 健康且 R2 正常，Web/API 容器均为运行状态。

## Plan self-review

- Spec coverage: 图片放大、PDF.js 多页与缩放、worker/Next.js 客户端边界、R2 URL 生命周期、错误重试、回归测试和 VPS 部署均有对应任务。
- Placeholder scan: 未使用 TODO、TBD 或未定义的后续动作；测试替身和实现接口均明确到文件与 props。
- Type consistency: `PdfPreview` 的 `{ url, filename, onRetry }` 接口在 Task 2、Task 3、Task 4 中一致；公共弹层四个现有 props 不变。
