"use client";

import WelcomeTunnel from "@/components/dashboard/welcome/WelcomeTunnel";

/**
 * 工作台首屏：透视隧道欢迎页。
 *
 * 这里不再请求任何看板数据 —— 数据看板（KPI / 项目航迹 / 介入队列 / 支出趋势）
 * 已整块移除，首屏只回答「这是谁、这里能做什么」。真实数据入口在项目台账等业务页。
 *
 * 导航与账号区由 `(dashboard)/layout.tsx` 浮在上层；layout 对 /dashboard 已把
 * content padding 归零、routeView 设为 100svh，所以页面只需要撑满一屏，
 * 不使用 position: fixed（那会盖住导航浮层）。
 */
export default function DashboardPage() {
  return (
    <div data-dashboard-page="true" data-dashboard-welcome="true">
      <WelcomeTunnel />
    </div>
  );
}
