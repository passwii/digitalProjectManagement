# 登录页科幻身份握手实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变认证行为的前提下，把 `/login` 重塑为具有“地面站捕获 · 身份握手”语义的科幻登录体验，并完成桌面与移动端本地预览。

**Architecture:** 保留 `LoginPage` 的现有认证状态与 API 调用，增加一个只负责视觉舞台与字段状态同步的 `LoginSignalField` 客户端组件；登录页通过数据属性把表单焦点、加载、错误状态映射到捕获场。主要视觉由 `login.module.css` 负责，捕获场使用 CSS 几何与有限的 Framer Motion 动效，不引入新依赖。`/change-password` 继续使用基础表单样式，通过 `.solo` 分支避免被登录舞台覆盖。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、Framer Motion 13、现有 Vitest/TypeScript 检查。

## Global Constraints

- 保留手机号账号、密码、密码显示切换、错误校验、错误提示、认证 API、会话保存和跳转逻辑。
- 保留中文产品事实与业务词汇，不虚构客户、营收、性能或安全数据。
- 登录页必须支持键盘焦点、`role="alert"`、`prefers-reduced-motion` 与移动端 `100dvh` / safe-area。
- 动效优先使用 `transform`、`opacity`、有限阴影和伪元素；不得让动画成为可用性的前置条件。
- `/change-password` 仍能渲染并保持可操作，不依赖登录页专属的捕获场节点。

---

### Task 1: 建立捕获场组件边界

**Files:**
- Create: `web/components/login/LoginSignalField.tsx`
- Create: `web/components/login/LoginSignalField.module.css`
- Modify: `web/app/login/page.tsx:8-143`

**Interfaces:**
- `LoginSignalField` consumes `{ activeField: "phone" | "password" | null; loading: boolean; hasError: boolean }`。
- `LoginSignalField` produces an accessible decorative field (`aria-hidden="true"`) with static fallback labels rendered in the parent page where needed。

- [ ] **Step 1: Add the component contract and static geometry**

```tsx
export type LoginSignalFieldProps = {
  activeField: "phone" | "password" | null;
  loading: boolean;
  hasError: boolean;
};

export default function LoginSignalField({
  activeField,
  loading,
  hasError,
}: LoginSignalFieldProps) {
  return (
    <div
      className={styles.field}
      data-active-field={activeField ?? "none"}
      data-loading={loading ? "true" : "false"}
      data-error={hasError ? "true" : "false"}
      aria-hidden="true"
    >
      <div className={styles.orbit}>
        <span className={styles.orbitRing} />
        <span className={styles.orbitRing} />
        <span className={styles.sweep} />
        <span className={styles.target} />
        <span className={styles.node} />
      </div>
      <div className={styles.readout}>
        <span>LINK / AUTH</span>
        <strong>{loading ? "HANDSHAKE" : hasError ? "RETRY SIGNAL" : "ACQUISITION"}</strong>
      </div>
      <div className={styles.metricRow}>
        <span>NODE 07</span>
        <span>SYNC {loading ? "--" : "100%"}</span>
        <span>LAT 08ms</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render the component inside the existing story area**

保留 `.storyTop`、`.storyMain`、`.storyFoot` 的产品文案，把 `LoginSignalField` 放在 `.storyMain` 前后合适位置，并让它只承担装饰与状态可视化，不重复认证文案。

- [ ] **Step 3: Type-check the new boundary**

Run: `npm --prefix web exec tsc -- --noEmit`

Expected: PASS with no TypeScript errors.

### Task 2: 实现身份握手动效与控制台状态

**Files:**
- Modify: `web/app/login/page.tsx:22-143`
- Modify: `web/app/login/login.module.css:1-286`
- Modify: `web/components/ui/PasswordInput.module.css:1-56`

**Interfaces:**
- The page continues to own `username`, `password`, `fieldErr`, `apiErr`, and `loading`.
- The page derives `activeField` from focus/blur state and passes it to `LoginSignalField`.
- The submit button remains the only submit action and uses existing loading/error strings.

- [ ] **Step 1: Add focus state and field state attributes**

```tsx
const [activeField, setActiveField] = useState<"phone" | "password" | null>(null);

const hasError = Boolean(fieldErr || apiErr);
```

Add `onFocus={() => setActiveField("phone")}` and `onBlur={() => setActiveField(null)}` to the phone input. Pass `onFocus` and `onBlur` through `PasswordInput` so the password field can use the same mapping; preserve the current public props by making the callbacks optional.

- [ ] **Step 2: Expose loading/error state on the form shell**

```tsx
<section className={st.auth} data-auth-state={loading ? "loading" : hasError ? "error" : "ready"}>
```

Use `data-auth-state` only for visual changes: button progress, console status, error edge treatment, and signal-field state.

- [ ] **Step 3: Replace the white business card visual with the dark control console**

Use a deep solid surface, crisp 1px boundary, inset technical rules, and a restrained cyan accent. Keep the existing semantic card structure so `change-password` can still share the base styles through `.solo`.

- [ ] **Step 4: Author one motion grammar**

Use keyframes for the scan sweep, orbit drift, node pulse, card entry, and submit loading state. The initial state must remain visible without animation. Inside `@media (prefers-reduced-motion: reduce)`, set animation duration to `1ms`, remove transforms/blur, and keep active/error colors and text visible.

- [ ] **Step 5: Run existing motion and type checks**

Run: `npm --prefix web run test:motion`

Expected: PASS.

Run: `npm --prefix web exec tsc -- --noEmit`

Expected: PASS.

### Task 3: Add responsive composition and browser-surface polish

**Files:**
- Modify: `web/app/login/login.module.css:1-420`
- Modify: `web/components/login/LoginSignalField.module.css:1-260`
- Modify: `web/app/globals.css:1-140` only if focus/selection tokens need a global value.

**Interfaces:**
- Desktop: two-region composition at 1280–1600px.
- Narrow desktop/tablet: stacked composition below 980px.
- Mobile: safe-area-aware single-stage composition below 767px; all tap targets remain at least 44px.

- [ ] **Step 1: Author desktop geometry**

Keep the story region fluid and the console constrained with `clamp()` padding. Use pseudo-elements and CSS gradients only for coordinate rules, orbital lines, and scan surfaces that belong to the ground-station world.

- [ ] **Step 2: Author mobile geometry**

```css
@media (max-width: 767px) {
  .wrap {
    min-height: 100vh;
    min-height: 100dvh;
    padding: calc(env(safe-area-inset-top, 0px) + 18px) 18px
      calc(env(safe-area-inset-bottom, 0px) + 18px);
  }

  .card { width: 100%; padding: 22px 18px 18px; }
  .field input { min-height: 46px; font-size: 16px; }
  .submit { min-height: 48px; }
}
```

Preserve the existing rule that allows the document to scroll when the software keyboard reduces the visual viewport.

- [ ] **Step 3: Style browser surfaces**

Theme selection color, caret color, placeholder color, scrollbar thumb, focus rings, and password toggle hover/focus from the same palette. Do not hide native focus.

- [ ] **Step 4: Verify change-password isolation**

Open `/change-password` or render the route in the running app and confirm it keeps a readable dark/neutral form surface without requiring `LoginSignalField`.

### Task 4: Run local preview and visual verification

**Files:**
- Create: `.impeccable/review/desktop.png`
- Create: `.impeccable/review/mobile.png`
- Modify: no source files unless verification finds a concrete defect.

- [ ] **Step 1: Start the web app**

Run: `npm --prefix web run dev`

Expected: Next.js serves `http://127.0.0.1:3001` and `/login` returns 200.

- [ ] **Step 2: Capture the desktop viewport**

Open `/login` at 1440px wide, wait for the first animation to settle, and capture the full page to `.impeccable/review/desktop.png`. Confirm the login card, capture field, labels, and button are visible.

- [ ] **Step 3: Capture the mobile viewport**

Open `/login` at 390px wide and capture to `.impeccable/review/mobile.png`. Confirm the field, console, button, copyright, safe-area padding, and vertical scroll behavior.

- [ ] **Step 4: Exercise state transitions**

Focus phone, focus password, submit empty, enter an invalid phone, toggle password visibility, and submit with a valid-shaped phone/password. Confirm each state remains readable and the button loading state does not shift layout.

- [ ] **Step 5: Run production checks**

Run: `npm --prefix web run build`

Expected: PASS.

Run: `/Users/damon/.agents/skills/impeccable/scripts/impeccable detect --json web/app/login/page.tsx web/app/login/login.module.css web/components/login/LoginSignalField.tsx web/components/login/LoginSignalField.module.css`

Expected: no unresolved mechanical finding that contradicts the design brief; fix concrete findings before final handoff.
