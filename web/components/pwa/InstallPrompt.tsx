"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { siteIdentityFor } from "@/lib/siteIdentity";
import s from "./InstallPrompt.module.css";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const DISMISS_KEY = "pm:pwa-install-dismissed-at";
const DISMISS_TTL = 7 * 24 * 60 * 60 * 1000;

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator &&
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  );
}

function isIos() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isMobileDevice() {
  return (
    /android.*mobile|iphone|ipad|ipod|windows phone|iemobile|opera mini|kaios/i.test(
      navigator.userAgent,
    ) ||
    // iPadOS 13+ 默认伪装成桌面版 macOS，但仍暴露多点触控能力。
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export default function InstallPrompt() {
  const pathname = usePathname();
  /*
   * 文案按**当前所在站点**取（BLF-1389）。
   *
   * 之前这里恒为「安装数科云办公」：组件挂在根布局上，所以在两个独立站点的
   * 路由上也会渲染 —— 用户明明在看云电竞管理平台，弹出来的却是
   * 「将数科云办公安装到手机」，装进去的也是主工作台（浏览器按 manifest
   * 的 `scope` 判定装的是哪个应用）。
   */
  const site = siteIdentityFor(pathname);
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isStandalone() || !isMobileDevice()) return;

    // 注册一个最小的 service worker，让支持安装的浏览器把本站识别为可安装应用。
    // 不接管请求、不做缓存，避免部署新版本时引入旧资源或离线数据风险。
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // 安装提示不是核心业务；注册失败时仍保留 manifest / iOS 安装引导。
      });
    }

    const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) ?? 0);
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL) return;
    if (dismissedAt) window.localStorage.removeItem(DISMISS_KEY);

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setInstallEvent(null);
      setVisible(false);
      setShowIosHelp(false);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // iOS Safari 不派发 beforeinstallprompt，只能给出系统菜单路径提示。
    if (isIos()) setVisible(true);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!visible || isStandalone() || !isMobileDevice()) return null;

  function dismiss() {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setVisible(false);
    setShowIosHelp(false);
  }

  async function install() {
    if (!installEvent) {
      setShowIosHelp(true);
      return;
    }
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    setInstallEvent(null);
    if (choice.outcome === "accepted") setVisible(false);
  }

  return (
    <aside className={s.prompt} role="dialog" aria-label={`安装${site.name}`}>
      <div className={s.icon} aria-hidden="true">
        {site.shortName.slice(0, 1)}
      </div>
      <div className={s.copy}>
        <strong>安装{site.name}</strong>
        {showIosHelp ? (
          <span>点击 Safari 底部的分享按钮，再选择“添加到主屏幕”。</span>
        ) : (
          <span>将{site.name}安装到手机。</span>
        )}
      </div>
      <button className={s.install} type="button" onClick={install}>
        {showIosHelp ? "知道了" : "安装"}
      </button>
      <button
        className={s.close}
        type="button"
        onClick={dismiss}
        aria-label="暂不安装"
      >
        <span aria-hidden="true">×</span>
      </button>
    </aside>
  );
}
