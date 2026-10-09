// 页面正文顶部：只读屏的标题 + 主操作区（BLF-1140）。
//
// 正文里再写一遍「页面标题 + 一句描述」属于冗余，标题由顶栏承担（顶栏标题的放大
// 打磨见 BLF-1139/S2）。但顶栏那层是纯文本 <span>，读屏拿不到「这是哪一页」的语义，
// 所以这里仍渲染一个视觉隐藏的 <h1>：每页恰好一个 h1，不产生可见文案。
// （项目详情页 projects/[id] 自带可见 h1，不使用本组件，不会出现两个 h1。）
//
// actions 是页面主操作（+ 新建项目 / 刷新 / 待审批 N / + 支出 …），必须留在首屏，
// 因此单独成一行右对齐、走 .page-head/.actions 这套既有版式（含 ≤640px 的铺满规则）。
// 没有主操作的页签（例如系统管理的「日志」）不传 actions，避免渲染出一条空行。
import type { ReactNode } from "react";
import MotionReveal from "@/components/motion/MotionReveal";
import { useRegisterPageTitle } from "./PageTitleContext";

export default function PageActions({
  title,
  actions,
}: {
  /** 仅供读屏的页面标题，与顶栏面包屑同一份文案 */
  title: string;
  /** 页面主操作按钮；不传则不渲染操作行 */
  actions?: ReactNode;
}) {
  useRegisterPageTitle(title);

  return (
    <>
      <h1 className="sr-only">{title}</h1>
      {actions ? (
        <MotionReveal className="page-head actions-only">
          <div className="actions no-print">{actions}</div>
        </MotionReveal>
      ) : null}
    </>
  );
}
