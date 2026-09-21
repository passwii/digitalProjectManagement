# 公共附件预览：图片放大与 PDF.js 渲染设计

## 背景与目标

当前公共附件预览组件已经可以判断图片和 PDF，但 PDF 依赖浏览器对 Blob URL 的原生 `<iframe>` 阅读器支持。图片可以正常加载，PDF 在实际浏览器中存在空白或无法打开的情况；现有测试只验证了 iframe 节点存在，不能证明 PDF 内容真的渲染。

本次调整只改公共组件，不修改项目台账、友商、通讯录和费用凭证等业务页面的接入方式，目标是：

1. 图片在普通预览状态下再次点击后进入全屏放大查看。
2. PDF 使用 PDF.js 渲染，支持多页纵向查看和缩放，不再依赖浏览器内置 PDF 插件。
3. 保留现有 R2 鉴权取 URL、失败分层、重试、下载和 Blob URL 生命周期管理。

## 方案选择

### 方案 A：继续使用原生 iframe / embed

改动最小、无需增加依赖，但 PDF 是否可见仍受浏览器内置阅读器、Blob URL 和嵌套弹层环境影响，无法解决当前问题，放弃。

### 方案 B：使用 `react-pdf`（推荐）

使用 React 18 兼容的 `react-pdf` 9.x，由 Mozilla PDF.js 负责解析并将每页绘制到 Canvas。公共组件负责传入 Blob URL、页数、缩放和错误状态，PDF 子组件负责 PDF.js 的 worker 和页面渲染。该方案跨浏览器行为稳定，且不要求业务页面逐一改造。

### 方案 C：使用 `@react-pdf-viewer` 完整工具栏

可以快速获得较完整的 PDF 工具栏，但需要引入 core、toolbar、default-layout 等多个包，UI 与当前系统样式耦合较弱，包体积和定制成本高于当前需求，暂不采用。

## 组件设计

### `AttachmentPreviewDialog`

保持现有公共接口：

- `attachment`：当前附件或 `null`。
- `loadUrl`：业务模块提供的鉴权 Blob URL 加载函数。
- `onClose`：关闭回调。
- `onDownload`：下载回调。

图片路径增加 `imageZoomed` 状态。普通预览中的图片可点击，点击后显示固定定位的全屏图片层，图片使用 `object-fit: contain`，遮罩点击、关闭按钮和 Escape 均可退出放大状态。关闭附件预览时同时重置放大状态。

PDF 路径改为渲染独立的 `PdfPreview` 客户端子组件：

- `Document` 加载当前 Blob URL。
- `Page` 按页纵向渲染，默认适应容器宽度。
- 提供缩小、放大、重置/适应宽度按钮，以及当前页数信息。
- PDF.js worker 只在客户端配置，避免 Next.js 服务端渲染和 worker 打包冲突。
- PDF 解析或渲染失败时显示可读错误，保留下载按钮。

图片和 PDF 都继续使用 `previewBlobType` 生成安全 MIME；组件只消费 Blob URL，不接触下载响应中的不可信 `Content-Type`。

## 数据流与生命周期

业务页面仍然只负责调用现有 `fetchObjectUrl(path, previewBlobType(attachment))`。公共组件加载成功后将 URL 交给图片或 PDF.js；附件切换、关闭、卸载和异步加载晚到时，统一撤销组件自己持有的 Blob URL。PDF.js 的页面状态在附件切换时清空，避免上一份 PDF 的页数或缩放状态污染下一份附件。

## 测试设计

先补失败测试，再实现：

- 图片：点击普通预览图片后出现全屏放大层，关闭后恢复普通状态。
- PDF：渲染 PDF.js `Document`，加载页数后生成对应数量的 `Page`；缩放按钮改变 scale；解析失败显示错误。
- 生命周期：切换/关闭/卸载仍只撤销组件自己创建或取得的 Blob URL。
- 回归：Word/Excel 仍显示下载引导，业务页面仍复用同一个公共组件。
- 执行现有前端单元测试、动效测试、生产构建和后端测试。

## 非目标

- 不新增后端接口和数据库字段。
- 不为 Word、Excel 增加在线编辑或在线预览。
- 不修改各业务页面的附件加载和下载 API。
- 不引入完整 PDF 编辑、批注、打印等超出当前需求的功能。
