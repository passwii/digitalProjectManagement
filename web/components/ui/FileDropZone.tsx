"use client";
/**
 * 通用文件上传区：点击选择 + 拖拽 + 粘贴（截图直接上传），带逐文件进度与拒绝提示。
 *
 * 设计要点：
 *   · 体积上限与白名单来自 `@/lib/uploadLimits`（单一来源），组件内不出现第二份阈值；
 *   · 判断逻辑在 `@/lib/uploadZone`（纯函数、可单测），本组件只负责事件绑定与渲染；
 *   · 进度用 `role="progressbar"` + `aria-valuenow` 播报，屏幕阅读器可读，纯视觉进度条不接受；
 *   · 上传中的文件行展示各自百分比与结果，多文件时能看出「是哪一个失败了」。
 *
 * 两种外观：
 *   variant="dropzone"  —— 大块虚线区域（表单内多选附件）
 *   variant="button"    —— 按钮外观（工具栏里的「上传图片」）
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  acceptFor,
  attachmentSizeLabel,
  formatFileSize,
} from "@/lib/uploadLimits";
import {
  filesFromPaste,
  filesFromTransfer,
  isFileDrag,
  partitionForZone,
  shouldHandlePaste,
} from "@/lib/uploadZone";
import { failureLine } from "@/lib/uploadErrors";
// 条目类型与状态迁移的唯一来源：hook 与组件共用同一份定义，避免两处漂移
import type { UploadItem } from "@/lib/uploadQueueCore";
import st from "./FileDropZone.module.css";

// 既有引用方从组件导出类型，这里继续转发，避免调用点大改
export type { UploadItem };

/** 单个文件的上传状态（由调用方驱动，组件只负责渲染）。 */
export interface FileDropZoneProps {
  /** 白名单扩展名（来自 `@/lib/uploadLimits` 的常量）。 */
  extensions: readonly string[];
  /** 提交入口；每次调用对应一个文件。 */
  onFiles: (files: File[]) => void;
  /** 渲染中的条目（上传进度 / 结果）。 */
  items?: readonly UploadItem[];
  /**
   * 重试一个失败条目（按条目 id）。
   *
   * 只在条目的失败分层标了 `retryable` 时才渲染按钮：502（存储暂不可用）有按钮，
   * 404（附件已丢失）与 400（不合规）**没有** —— 重试一万次也不会变。
   */
  onRetry?: (id: number) => void;
  /** 整体禁用（例如父级提交中）。 */
  disabled?: boolean;
  /**
   * 允许一次收多个文件。
   *
   * 注意这是**组件级**语义，覆盖点击选择 / 拖拽 / 粘贴三条路径：
   * 仅靠原生 `<input multiple>` 只约束点击选择，拖拽与粘贴会绕过它
   * （历史上 `multiple={false}` 的入口拖入多个文件时静默只上传第一个）。
   */
  multiple?: boolean;
  variant?: "dropzone" | "button";
  /** 主文案 / 按钮文案。 */
  label: string;
  /** 主文案下方的说明（仅 dropzone 展示）。 */
  hint?: string;
  /** 无障碍描述；默认由 label + hint 拼出。 */
  ariaLabel?: string;
  className?: string;
}

let seq = 0;
/** 生成条目 id（组件内部兜底用，避免同名文件 key 冲突）。 */
export function nextUploadId(): number {
  return ++seq;
}

export default function FileDropZone({
  extensions,
  onFiles,
  items = [],
  onRetry,
  disabled = false,
  multiple = true,
  variant = "dropzone",
  label,
  hint,
  ariaLabel,
  className,
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  /** 最外层容器：包裹 zone 与（被移出去的）input，粘贴监听挂在这里。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  /** 被拒文件的提示（类型/体积不通过）：单独成行，绝不静默丢弃。 */
  const [localRejected, setLocalRejected] = useState<{ id: number; name: string; reason: string }[]>([]);
  const dragDepth = useRef(0);
  const describedBy = useId();

  const accept = acceptFor(extensions);

  /**
   * 统一入口：合法文件交给调用方，非法或超量的文件一定给出可读提示。
   *
   * 决策全在 `partitionForZone`（纯函数、有单测），组件只负责渲染拒绝行。
   */
  const submit = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const { accepted, rejected } = partitionForZone(files, extensions, multiple);
      if (rejected.length) {
        setLocalRejected((prev) => [
          ...prev,
          ...rejected.map((row) => ({ id: nextUploadId(), ...row })),
        ]);
      }
      if (accepted.length) onFiles(accepted);
    },
    [extensions, multiple, onFiles],
  );

  const openPicker = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  // ---- 拖拽：只用 dragenter/dragleave 计数维护高亮，避免子元素间移动时闪烁 ----
  const onDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !isFileDrag(event.dataTransfer?.types)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    [disabled],
  );

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !isFileDrag(event.dataTransfer?.types)) return;
      // 必须阻止默认行为，否则浏览器会当作导航处理并打开文件
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [disabled],
  );

  const onDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    [disabled],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (disabled) return;
      submit(filesFromTransfer(event.dataTransfer));
    },
    [disabled, submit],
  );

  // ---- 粘贴：只在事件落在上传区容器内且目标不是可编辑元素时接管 ----
  // 挂在容器（而非 document）上，页面别处粘贴根本进不到这里，不会被劫持。
  // 容器同时包含 zone 与隐藏 input，因此两者谁拿到焦点都能接管。
  useEffect(() => {
    if (disabled) return;
    const root = rootRef.current;
    if (!root) return;

    const handlePaste = (event: ClipboardEvent) => {
      const files = filesFromPaste(event.clipboardData);
      if (!files.length) return; // 纯文本/HTML 粘贴：完全不插手
      if (!shouldHandlePaste(event.target, root)) return; // 焦点不在区内或是输入框：放行
      event.preventDefault();
      submit(files);
    };

    root.addEventListener("paste", handlePaste);
    return () => root.removeEventListener("paste", handlePaste);
  }, [disabled, submit]);

  // 卸载时清掉兜底提示，避免复用时残留上一个入口的报错
  useEffect(() => () => setLocalRejected([]), []);

  // 拖拽高亮的安全网：拖拽被 Esc 取消、或在区域外松手时，本组件收不到
  // dragleave/drop，计数会停在非零、高亮永远不消退。全局 dragend/drop
  // 一次性把状态归零（只挂 window，不干扰区域内自己的处理）。
  useEffect(() => {
    const clear = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  const onInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      // 先清空 value：同一个文件连续选两次也要能触发 change
      event.target.value = "";
      submit(files);
    },
    [submit],
  );

  const description = ariaLabel ?? hint ?? `支持 ${accept.replace(/\./g, "").toUpperCase()}，单个文件不超过 ${attachmentSizeLabel()}`;

  // 进度行与被拒行合成同一个列表：用户看到的是「这批文件的处理结果」，
  // 分成两个列表会让「哪个文件被拒」和「哪个文件在上传」看不出先后。
  const hasRows = items.length > 0 || localRejected.length > 0;
  const list = hasRows && (
    <ul className={st.list}>
      {items.map((item) => (
        <li key={item.id} className={st[`row_${item.status}`] ?? st.row}>
          <span className={st.name} title={item.name}>{item.name}</span>
          {typeof item.size === "number" && <span className={st.size}>{formatFileSize(item.size)}</span>}
          {item.status === "uploading" && <ProgressMeter percent={item.progress} />}
          {item.status === "done" && <span className={st.done}>已完成</span>}
          {item.status === "error" && (
            <span className={st.failRow}>
              {/* 徽标是「肉眼可分」的关键：502 与 404 不再是同一句泛化文案 */}
              {item.failure && (
                <span
                  className={`${st.failTag} ${item.failure.retryable ? st.failTagRetry : st.failTagLost}`}
                >
                  {item.failure.label}
                </span>
              )}
              <span className={st.fail} role="alert">
                {item.failure ? failureLine(item.failure) : item.message ?? "上传失败"}
              </span>
              {item.failure?.retryable && onRetry && (
                <button
                  type="button"
                  className={st.retry}
                  disabled={disabled}
                  onClick={() => onRetry(item.id)}
                >
                  重试
                </button>
              )}
            </span>
          )}
        </li>
      ))}
      {localRejected.map((row) => (
        <li key={row.id} className={st.row_rejected}>
          <span className={st.name} title={row.name}>{row.name}</span>
          <span className={st.fail} role="alert">{row.reason}</span>
        </li>
      ))}
    </ul>
  );

  const isButton = variant === "button";

  return (
    <div ref={rootRef} className={`${isButton ? st.buttonWrap : st.wrap} ${className ?? ""}`}>
      <div
        className={[
          isButton ? st.button : st.zone,
          dragging ? st.dragging : "",
          disabled ? st.disabled : "",
        ].filter(Boolean).join(" ")}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label={`${label}：${description}`}
        aria-describedby={hint ? describedBy : undefined}
        onClick={openPicker}
        onKeyDown={(event) => {
          // Enter / Space 都要能唤起选择器；同时阻止 Space 滚动页面
          if (event.key !== "Enter" && event.key !== " ") return;
          if (disabled) return;
          event.preventDefault();
          openPicker();
        }}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {isButton ? (
          <span className={st.buttonLabel}>{label}</span>
        ) : (
          <>
            <span className={st.main}>{label}</span>
            {(hint || dragging) && (
              <span className={st.sub} id={describedBy}>
                {dragging ? "松开鼠标即可上传" : hint}
              </span>
            )}
          </>
        )}
      </div>
      {/* input 必须放在可点击区域之外：它嵌套在里面时，`input.click()` 触发的
          click 事件会冒泡回 onclick 再次调用 openPicker，形成递归。 */}
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        multiple={multiple}
        accept={accept}
        disabled={disabled}
        onChange={onInputChange}
        tabIndex={-1}
        // 键盘可达性由外层 role="button" 承担，input 自身不再进 Tab 序列
        aria-hidden="true"
      />
      {list}
    </div>
  );
}

/** 进度条：`percent === null` 表示体积不可知，渲染不确定态而不是伪造 0%。 */
function ProgressMeter({ percent }: { percent: number | null }) {
  const known = percent !== null;
  return (
    <span className={st.meter}>
      <span
        className={`${st.track} ${known ? "" : st.trackIndeterminate}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? percent : undefined}
        aria-valuetext={known ? `${percent}%` : "上传中，进度未知"}
        title={known ? `${percent}%` : "上传中"}
      >
        <span className={st.fill} style={known ? { width: `${percent}%` } : undefined} />
      </span>
      <span className={`mono ${st.percent}`}>{known ? `${percent}%` : "…"}</span>
    </span>
  );
}
