"use client";

import MobileHome from "@/components/dashboard/MobileHome";
import WelcomeTunnel from "@/components/dashboard/welcome/WelcomeTunnel";
import { useMobilePwaViewport } from "@/lib/mobilePwaViewport";

/**
 * 工作台首屏：桌面是透视隧道欢迎页，手机（≤767px）是已确认草稿
 * docs/prototypes/mobile-pwa 的移动首页（品牌顶栏由外壳提供，页面只负责
 * 问候 / 四张入口卡 / 通讯录与新建项目 quick rows）。
 *
 * 首页不请求任何看板数据；真实数据入口在项目台账等业务页。
 * 导航与账号区由 (dashboard)/layout.tsx 浮在上层；layout 对 /dashboard 已把
 * content padding 归零，手机端把 content 设为内部滚动，页面只需要撑满一屏。
 */
export default function DashboardPage() {
  const mobileViewport = useMobilePwaViewport();

  return (
    <div data-dashboard-page="true" data-dashboard-welcome={mobileViewport ? undefined : "true"}>
      {mobileViewport ? <MobileHome /> : <WelcomeTunnel />}
    </div>
  );
}
