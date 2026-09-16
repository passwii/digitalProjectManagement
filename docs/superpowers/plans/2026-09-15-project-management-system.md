# 项目管理系统 Implementation Plan（打磨版概要PLAN）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于《项目管理系统需求说明书 V1.0》输出 MVP 可开工的 Stage 化计划，Next.js + FastAPI + SQLite，首批 Stage 0 登录先行交付。

**Architecture:** 前后端分离，Next.js App Router 只调 FastAPI REST API，不直连 DB。FastAPI + SQLAlchemy + Alembic + SQLite WAL 单文件启动，JWT 会话 + RBAC 中间件 + 审计留痕贯穿所有 Stage。

**Tech Stack:** Next.js 14+ (TypeScript) + FastAPI + SQLAlchemy 2.0 + Alembic + SQLite (WAL), 鉴权 JWT (access 2h / refresh 7d), 文件本地存储, 导出 openpyxl / Excel 模板导入

## Global Constraints

- DB（MVP）：`sqlite:///./data/app.db`，WAL + `busy_timeout=30s` + 外键 ON；PG 不在本期范围，不做适配验证
- 未登录访问任何业务页/接口一律 401 + 重定向 `/login`；关键操作全量审计
- 列表分页 + 索引先行，MVP 千级流畅；Chrome/Edge 近两版，`app.db` 每日文件备份留 7 天
- 成本为项目管理口径，与财务账差异报表注明

---

## 1. 原文档缺口（已补进各 Stage）

0. 登录页缺失 → Stage 0 补齐
1. 状态机无值 → Stage 1 补：草稿/已立项/进行中/暂停/已完成/已归档/已取消
2. 编号并发策略缺 → Stage 1 补：DB 唯一索引 + 年事务取号
3. 5.2.4 空章节 → Stage 2 补：三视图 + 三预警 + 定时 job
4. 加权公式缺 → Stage 2 补：`Σ(进度×权重)/Σ权重`
5. 预算规则糊 → Stage 3 补：80% 可配、超预算拦截/特批
6. 审批节点缺 → Stage 1/3 补：最小可用 0/1 级
7. 权限并集冲突缺 → Stage 1 补：项目成员授权 > 部门隔离
8. 附件/导入/通知缺规格 → 各 Stage 补：20MB 白名单、Excel 模板列、站内信先行

## 2. 范围

做：Stage 0 登录 → Stage 1 台账+系统管理 → Stage 2 进度 → Stage 3 成本 → Stage 4 加固上线
不做：CRM、招投标、合同全生命周期、财务记账、人力绩效、原生 App

## 3. 目录与接口域

```text
web/app/login/page.tsx
web/app/(dashboard)/projects/page.tsx + [id]/page.tsx (详情/跟进/附件)
web/app/(dashboard)/progress/ (列表/看板/甘特图)
web/app/(dashboard)/costs/ + reports/page.tsx
api/routers/auth.py admin.py projects.py tasks.py milestones.py budgets.py expenses.py reports.py
api/core/database.py security.py rbac.py audit.py jobs.py (预警定时)
```

`/api/v1/auth/login|logout|me, /projects, /followups, /tasks, /milestones, /progress-logs, /budgets, /expenses, /reports, /admin/*`

---

## Stage 0：登录 + 技术底座（第一批，阻塞后续）

**目标：** 可登录、可鉴权、可审计，之后所有 Stage 复用会话。

流程：
1. 访问 `/` 或任意业务页 → middleware 无 token → 302 `/login`
2. `/login` 填账号密码 → `POST /auth/login` → bcrypt 验密 → 发 access+refresh → 跳 `/projects`
3. 业务请求带 `Authorization: Bearer` → 401 则清会话回 `/login`；`GET /auth/me` 拉角色菜单
4. 右上角登出 → `POST /auth/logout` → 服务端拉黑 jti（SQLite 表）+ 清 cookie
5. 连续 5 错锁 15min（`sys_params` 可配）；成功/失败都写 `audit_logs`

页面：`login/page.tsx`（无侧栏布局、空值拦截、错密不提示用户是否存在、移动端自适应）
接口：`POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/refresh`
表：`users(id, username UNIQUE, pwd_hash, status, dept_id)`, `audit_logs`, `token_blacklist(jti)`, 种子管理员 `admin/admin123456` 首次强制改密
验收：
- [ ] 空账号密码前端拦截；错密 5 次锁定；未登录调业务接口 401
- [ ] 登录/登出/失败审计可按时间/人查；`admin` 改密前横幅提醒
产出后 Stage 0 可独立演示登录闭环。

## Stage 1：项目台账 + 系统管理

**目标：** 统一台账可用，权限隔离生效。

核心流程设计：
1. 创建：负责人填 10 字段（名称唯一/类型/部门/负责人/成员/计划起止/预算/优先级/简介/客户）→ 事务内生成 `PJ-2026-0001`（年序列+唯一索引）→ 状态=草稿（若立项审批开则待审批→已立项，否则直接已立项）
2. 状态机：草稿→已立项→进行中↔暂停→已完成→已归档（只读，管理员可解）；取消仅草稿/已立项可转；每次流转记操作人/时间/原因
3. 编辑留痕：所有字段变更写 `project_changes(field, old, new, by, at)`，详情页可查时间线
4. 附件：白名单 pdf/docx/xlsx/png/jpg，单 20MB，存本地 `data/files/{project_id}/`，已归档禁传
5. 跟进：`followups(跟进人/时间/方式/内容/下一步/remind_at)`，`jobs.py` 每 10min 扫到期 remind → 站内通知；支持按人/时间筛 + 导出
6. 检索：列表组合筛（名称/编号/状态/负责人/部门/时间）+ 关键字 LIKE 高亮，分页 20/条
7. RBAC：6 角色并集（写>读），项目成员授权优先于部门隔离；部门负责人看本部门，成本看成本域，高层只读；越权 403 + 审计

页面：`projects` 列表/新建/详情（基本/变更/附件/跟进 4 Tab）、`admin` 用户/角色/字典/参数/日志
接口：`CRUD /projects`, `/projects/{id}/archive|unarchive|status`, `/followups`, `/admin/users|roles|dicts|params|logs`
验收：
- [ ] 编号全局唯一、必填校验全；变更前后值可追溯；归档只读
- [ ] 不同角色登录可见数据隔离正确；提醒到期站内收到

## Stage 2：进度跟进

**目标：** 任务可分可报，逾期有人喊。

流程设计：
1. 里程碑：负责人建（名称/计划日/负责人）→ 到期前 3 天（可配）预警 → 填实际日关闭；逾期标红
2. WBS：多级（限 5 级）任务（名称/负责人/计划起止/权重/前置 id）；建依赖时环检测拦截；前置未完成仍可建但保存提示
3. 导入：Excel 模板列 `层级/名称/负责人账号/计划开始/计划结束/权重`，逐行校验报错定位行号
4. 填报：成员只能报自己任务（进度 %/说明/剩余工期）→ 写 `progress_logs` → 项目进度=加权 `Σ(进度×权重)/Σ权重`（权重缺省均分）→ 负责人一键确认快照
5. 预警 job（`jobs.py` 每日 02:00 + 实时标红）：任务超计划 end 未 100% 逾期；项目 N 天（默认 7）无填报停滞；三类都推站内 + 列表徽标
6. 视图：列表（默认）/看板（按状态）/甘特图（只读拖拽二期），周报一键生成本周变化+待办（可选）

页面：`progress` 三视图 + 任务抽屉 + 填报弹窗
接口：`/milestones`, `/tasks`, `/tasks/import`, `/progress-logs`, `/projects/{id}/progress`, `/jobs/warnings`
验收：
- [ ] 逾期/临近/停滞三预警可复现；填报历史可查；加权值手工验算一致

## Stage 3：成本支出

**目标：** 预算卡得住，超支拦得下。

流程设计：
1. 预算：按项目×科目（人工/采购/外包/差旅/其他）填金额+期间，期间须落在项目计划起止内；调整走 1 级审批（成本管理员）并留痕，自动重算执行数
2. 支出：经办人登记（项目/科目/金额/日期/说明/发票附件）→ 若审批开关开则负责人或成本管理员批 → 通过计入执行，驳回可改重提
3. 执行公式：`已支出=已通过支出 Σ`，`余额=预算-已支出`，`执行率=已支出/预算`；达 80%（阈值可配）站内提醒；超预算默认拦截，只能调预算或特批单放行
4. 报表：按项目/科目/部门/时间四维度汇总，页面数与 Excel 导出口径一致（同一 service 函数），注明管理口径

页面：`costs` 预算/支出/执行条 + `reports` 四维度 + 导出按钮
接口：`/budgets`, `/budget-adjusts`, `/expenses`, `/expenses/{id}/approve|reject|exception`, `/reports/cost`
验收：
- [ ] 执行率实时正确；80% 提醒触发；超预算无特批写不进；导出口径与页面一致

## Stage 4：加固与上线（收尾）

- [ ] 索引复查 + 千级分页实测 ≤2s；登录限流 + 越权矩阵全测；`app.db` 备份恢复演练
- [ ] Chrome/Edge 近两版 + 移动端自适应走查；存量 Excel 导入核对；填报规范培训
- [ ] 原文 §7 八项验收全过即放行

## 4. 待确认 / 风险

待确认：立项审批开否、管理层；科目口径、财务部；IM/财务对接本期否、IT；部署与试点节奏、管理层。
风险：存量导入失真（模板+校验）、填报滞后（培训+停滞预警）、审批过重（最小可用先行）、口径争议（报表注明）。

---
*来源：项目管理系统需求说明书.docx V1.0；选型 Next.js + FastAPI + SQLite，Stage 0 登录先行。*
