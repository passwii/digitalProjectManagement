# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

企业内部的项目负责人、执行成员、财务/审批人员与管理员，在浏览器或 iPad 上登录工作台，处理项目治理与协同工作。

## Product Purpose

数科云办公是一套面向企业内部项目治理的数字化工作台，覆盖组织与账号、项目台账、进度任务、成本支出、审批、通知、报表、通讯录和安全审计。登录页的成功标准是让已授权用户快速、明确地进入管理工作台，同时让产品的“可信数据、持续推进、可追溯交付”气质在进入前就被感知。

## Positioning

它把项目台账、执行进度、成本与审批收敛到同一套带有权限边界和审计留痕的工作事实中，而不是只做任务列表或单一财务工具。

## Operating Context

用户通常在企业办公环境中使用手机号账号登录，登录成功后进入工作台；首次登录可能被要求修改密码。系统也需要适应窄屏与移动端安全区，并支持键盘操作和减少动效偏好。

## Capabilities and Constraints

- 前端为 Next.js 14 App Router、React 18、TypeScript；登录路由为 `/login`，首次改密路由为 `/change-password`。
- 登录凭据为 11 位手机号账号与密码；空值、格式错误、错误凭据和请求失败均需保留清晰可恢复的错误反馈。
- 登录成功后按服务端结果跳转到 `/change-password` 或 `/dashboard`。
- 现有移动端契约要求表单在手机安全区内保持可见、垂直居中，并在软键盘抬起时仍可滚动到主按钮。
- 不改变认证接口、会话保存、路由门禁或错误语义；视觉重设计只影响登录体验的表现层与动效。

## Brand Commitments

- 产品名称：数科云办公。
- 当前登录文案与业务词汇必须保持中文语境，包括“数字化项目运营”“项目协同 · 交付管理”“复杂有章，交付有信”“统一台账 / 进度留痕 / 支出归集”。
- 用户明确要求抛弃沉闷的商业化效果，转向具有科幻感、技术满足感的登录体验；这是本次登录页视觉重设计的绑定方向。

## Evidence on Hand

- 产品架构与前端约束：`README.md`。
- 登录页实现：`web/app/login/page.tsx`、`web/app/login/login.module.css`。
- 现有登录动效：`web/components/motion/StorySteps.tsx`、`web/components/motion/StorySteps.module.css`。
- 现有移动端契约：`docs/superpowers/specs/2026-09-18-mobile-pwa-navigation-design.md` 与 `docs/prototypes/blf-1127-mobile-pwa/`。
- 没有可用于登录页的真实客户、营收、性能或安全宣传数据；视觉中不得虚构这类证明。

## Product Principles

- 进入工作台必须快而明确。
- 业务事实优先于装饰性表达。
- 关键状态可追溯、可理解、可恢复。
- 桌面与移动端都要保持可用，不以动效牺牲表单操作。

## Accessibility & Inclusion

- 保留语义化表单、可见键盘焦点、错误 `role="alert"`、密码显示切换和 `prefers-reduced-motion` 支持。
- 重要文字需满足可读对比度；动效不能成为获取或完成登录的必要条件。
