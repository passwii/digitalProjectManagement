"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { siteIdentityFor, type SiteIdentity } from "@/lib/siteIdentity";
import s from "./InstallPrompt.module.css";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

/**
 * 弹层状态：事件、文案、归属三者必须**同源**。
 *
 * `manifest` = 这个事件归属的 manifest（浏览器会装的那个应用）；
 * `event` = 那一次性的 `beforeinstallprompt` 事件。
 */
type PromptState = {
  event: BeforeInstallPromptEvent | null;
  /** 事件归属的 manifest 路径（= 浏览器会装的那个应用）。 */
  manifest: string | null;
  visible: boolean;
};

const DISMISS_KEY = "pm:pwa-install-dismissed-at";
const DISMISS_TTL = 7 * 24 * 60 * 60 * 1000;

const EMPTY_PROMPT: PromptState = { event: null, manifest: null, visible: false };

/**
 * 页面上当前生效的 manifest 路径（`/spark/manifest.webmanifest` 这样的站内路径）。
 *
 * 用 `<link rel="manifest">` 而不是 `siteIdentityFor(pathname)`：这一份是
 * **浏览器真正拿去判定可安装性的那份清单**，装机前的校验必须对着它做。
 *
 * 站点身份表（`lib/siteIdentity.ts`）与各 layout 写的 `metadata.manifest`
 * 是同一套路径（`lib/siteManifest.vitest.test.ts` 守着这条），所以两者一致；
 * 但校验这一侧要用浏览器的口径 —— 免得「身份表说 A、浏览器装 B」。
 *
 * 页面里**没有** manifest link 时（jsdom 测试、或布局漏写），回落到当前站点
 * 身份表里那一份 —— 此时浏览器本来就无从判定可安装性，回落是唯一可用的口径，
 * 而不是把校验悄悄跳过。
 */
function domManifestPath(fallback: string): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  const href = link?.getAttribute("href");
  if (!href) return fallback;
  try {
    return new URL(href, window.location.origin).pathname;
  } catch {
    return fallback;
  }
}

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
  const [prompt, setPrompt] = useState<PromptState>(EMPTY_PROMPT);
  const [showIosHelp, setShowIosHelp] = useState(false);
  /** iOS Safari 不派发 beforeinstallprompt，弹层是「系统菜单路径」提示。 */
  const [isIosDevice, setIsIosDevice] = useState(false);
  /**
   * 当前站点（每次渲染都更新）。
   *
   * 事件监听是在**初次挂载**时注册的（依赖数组是 `[]`），闭包里的 `site`
   * 会一直是挂载那一刻的值 —— 跨站导航后拿到的事件会被算成「旧站点」，
   * 于是新站点的弹层永远不出现。所以监听器里要读**当前**站点，用 ref 传。
   */
  const siteRef = useRef<SiteIdentity>(site);
  siteRef.current = site;
  /** 上一次处理过的站点 manifest —— 用来识别「跨站导航」。 */
  const lastSiteManifest = useRef(site.manifest);

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
      /*
       * 连同「这份事件属于哪份 manifest」一起存下来（BLF-1389 复核 P1）。
       *
       * 事件是**页面级**的一次性机会：它对应的是**事件到达那一刻**浏览器
       * 读到的那份 manifest。跨站导航之后文案会立刻翻成新站点，而这个事件
       * 装的仍然是旧站点的应用 —— 「说要装 A、装出来是 B」。
       */
      const current = siteRef.current;
      setPrompt({
        event: event as BeforeInstallPromptEvent,
        manifest: domManifestPath(current.manifest),
        visible: true,
      });
    };
    const onInstalled = () => {
      setPrompt(EMPTY_PROMPT);
      setShowIosHelp(false);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // iOS Safari 不派发 beforeinstallprompt，只能给出系统菜单路径提示。
    if (isIos()) {
      setIsIosDevice(true);
      setPrompt((prev) => ({ ...prev, visible: true }));
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  /*
   * 跨站导航：旧站点的安装事件立刻作废（BLF-1389 复核 P1）。
   *
   * 为什么必须显式处理，不能指望浏览器兜底：
   *   · `beforeinstallprompt` 是**一次性**的页面级事件，而文案走
   *     `siteIdentityFor(pathname)` 每次渲染重算 —— 两者生命周期不同步，
   *     跨站导航后必然出现「文案已经是新站点、事件还属于旧站点」的错位：
   *     弹层承诺「安装云电竞管理平台」，装下去的却是数科云办公。
   *   · 实测（Chrome 140，非 incognito 持久化 profile + Android UA）：
   *     软导航后 Chrome **会**再派发一次 `beforeinstallprompt`，且新事件归属
   *     **新页面**的 manifest（同一个 document，约 120ms 后到达）。
   *     —— 也就是说「自愈」是**碰巧成立**的：它依赖浏览器版本行为，
   *     没有写进任何规范，而且不派发时（已安装、判定失败、其它浏览器）
   *     错位就是永久的。
   *   · 所以这里的口径是「**失败时收手**」：旧事件一律作废、弹层收起，
   *     等新站点的事件重新到达再弹。装错应用比这次不装更糟。
   */
  useEffect(() => {
    const previous = lastSiteManifest.current;
    lastSiteManifest.current = site.manifest;
    if (previous === site.manifest) return;
    setPrompt((prev) => {
      // 新站点的事件已经抢先到达（Chrome 软导航后会重新派发）：保留它。
      if (prev.event && prev.manifest === site.manifest) return prev;
      // iOS 没有事件，弹层是「系统分享菜单」路径提示：文案跟着站点走即可，弹层保留。
      if (isIosDevice) return { ...prev, event: null, manifest: null };
      // 旧事件装着别的应用 —— 收起来，等新站点的事件到达再弹。
      return EMPTY_PROMPT;
    });
    setShowIosHelp(false);
  }, [site.manifest, isIosDevice]);

  if (!prompt.visible || isStandalone() || !isMobileDevice()) return null;

  /*
   * 事件与当前站点必须**同源**：事件归属的 manifest 不是当前站点那份时，
   * 弹层不展示（更不许装）。这条在渲染期就拦一道，避免出现一帧
   * 「文案已经翻成新站点、按钮却绑着旧事件」的画面。
   */
  const eventIsCurrent =
    prompt.event !== null && prompt.manifest === site.manifest;
  if (!isIosDevice && !eventIsCurrent) return null;

  function dismiss() {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setPrompt((prev) => ({ ...prev, visible: false }));
    setShowIosHelp(false);
  }

  async function install() {
    if (!prompt.event) {
      // iOS：没有 beforeinstallprompt，只能走系统分享菜单 → 展开指引。
      if (isIos()) {
        setShowIosHelp(true);
        return;
      }
      // 其它平台：事件已经用掉了（用户刚才拒过），没有可装的应用 → 收掉弹层。
      setPrompt((prev) => ({ ...prev, visible: false }));
      return;
    }
    /*
     * 装机前的最后一道校验（BLF-1389 复核 P1）。
     *
     * 事件归属的 manifest 必须仍然是**当前页面生效**的那一份 —— 否则装下去的
     * 应用与用户看到的站点不是同一个。这道校验与「浏览器会不会重新派发事件」
     * 无关：宁可这次不装，也不能装错应用。
     */
    const current = domManifestPath(site.manifest);
    if (current !== prompt.manifest) {
      setPrompt(EMPTY_PROMPT);
      setShowIosHelp(false);
      return;
    }
    await prompt.event.prompt();
    const choice = await prompt.event.userChoice;
    setPrompt((prev) => ({ ...prev, event: null, manifest: null }));
    if (choice.outcome === "accepted") setPrompt((prev) => ({ ...prev, visible: false }));
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
