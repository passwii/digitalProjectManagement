# 审计日志中文展示设计

## 背景

`/admin?tab=日志` 当前直接渲染后端审计日志的 `action`、`resource` 和 `detail` 原始字段。动作码和资源码包含大量英文标识，例如 `create_project`、`projects`、`project=12`，管理员阅读成本较高。

目标是让日志页面的用户可见内容以中文为主，同时保留原始英文编码在筛选、接口和日志导出链路中的可追溯能力。

## 目标与范围

### 目标

- 日志列表中的动作、对象、详情显示中文文案。
- 日志详情抽屉与列表使用同一套中文格式化规则。
- 保留数据库、API 和日志导出的原始审计事实，不改后端审计契约。
- 英文动作码继续可用于动作筛选和排查，但不在页面日志字段中展示。
- 未来新增或暂未映射的编码有稳定中文兜底，不让英文原始码直接泄露到页面。

### 范围

- 新增前端审计日志展示格式化模块。
- 修改系统管理日志页的列表、分页提示和详情抽屉展示。
- 新增格式化模块单元测试，更新既有中文界面约束测试。

### 不在范围内

- 不修改 `audit_logs` 表结构或历史数据。
- 不修改 `GET /admin/logs` 的响应结构或筛选参数。
- 不修改审计写入入口，不把中文文案写入数据库。
- 不翻译业务用户输入的项目名、文件名、项目编码、金额和编号等事实值。

## 方案

采用前端集中映射层。新增 `web/lib/auditLogLabels.ts`，由纯函数负责将审计日志原始字段转换为展示文案；`web/app/(dashboard)/admin/page.tsx` 只在渲染边界调用格式化函数。

对外提供以下接口：

```ts
export function auditActionLabel(action: string, resource?: string): string;
export function auditResourceLabel(resource: string): string;
export function auditDetailLabel(action: string, resource: string, detail: string): string;
export function auditResourceDisplay(resource: string, resourceId?: string | null): string;
```

动作文案允许结合资源判断。这样 `create` 在 `voucher` 上显示为“创建凭证”，在 `account_book` 上显示为“创建账套”，而业务含义明确的动作码直接使用固定中文映射。

资源编号只作为动态事实值保留，例如 `projects` 和 `123` 组合为“项目 #123”。空或未知资源显示“其他资源”。

## 中文化规则

### 动作

覆盖当前后端审计入口产生的常见动作，包括登录、登出、改密、创建/更新/删除项目、附件操作、成员变更、跟进事项、任务、里程碑、联系人、友商、预算、支出、审批、财务凭证、系统用户、字典、参数和日志导出等。

通用动作 `create`、`update`、`delete`、`submit`、`approve`、`reject`、`post`、`void`、`reverse`、`close` 等使用资源上下文补充具体对象名称。

未知动作不输出原始编码，统一显示“其他操作”。

### 资源

将 `projects`、`attachments`、`auth`、`users`、`expenses`、`budgets`、`vouchers`、`audit_logs` 等资源码映射为中文对象名。未知资源显示“其他资源”。

### 详情

- 已经是中文的详情原样保留。
- `key=value`、逗号分隔的键值对和 Python 风格字段列表转换为中文键名。
- `old->new` 状态流转转换为“原值：old → 新值：new”；已知状态值转换为中文，未知业务值原样保留。
- `count`、`amount`、`project`、`task`、`voucher`、`period`、`book`、`active` 等结构化键使用中文标签。
- 动作词 `approve`、`reject`、`auto`、`delete draft voucher` 等已知固定片段转换为中文。
- 文件名、项目编号、项目名称、用户输入原因、金额和业务编号作为动态事实值保留。
- 空详情或无法安全识别的编码详情显示“操作详情已记录”，不直接显示未知英文标识。

## 数据流与兼容性

原始日志仍由 `adminApi.logs` 请求，并继续把输入动作码作为 `action` 参数传给后端。页面渲染时：

1. 列表动作列调用 `auditActionLabel(l.action, l.resource)`。
2. 列表对象列调用 `auditResourceDisplay(l.resource, l.resource_id)`。
3. 列表详情列调用 `auditDetailLabel(l.action, l.resource, l.detail)`，标题属性也使用中文结果。
4. 详情抽屉的动作、资源和详情字段复用同样的调用。

不把原始 `l.action`、`l.resource` 或 `l.detail` 直接作为用户可见文本或标题。API、数据库和导出仍保留原始值，因此管理员仍可用英文编码精确筛选和定位原始审计记录。

## 错误处理与兜底

- `null`、空字符串和缺失详情不会抛异常。
- 未知动作、资源和详情各自使用固定中文兜底。
- 格式化模块不修改输入对象，不承担请求、状态和副作用。
- 映射不完整只影响单条日志的文案，不影响日志列表加载和分页。

## 测试策略

新增单元测试覆盖：

- 常见动作和资源映射；
- 通用动作结合资源后的文案；
- 键值对、状态流转、数量、金额和字段列表详情；
- 中文详情、空详情和未知编码兜底；
- 动态文件名、业务编号和金额保留；
- 资源编号组合展示。

更新 `web/lib/chineseCopy.test.ts`，验证日志页调用集中格式化函数、不直接渲染原始动作和详情，同时移除旧的“保留英文动作码展示”断言。

验证顺序：先运行新单测并确认初始失败，再实现最小映射并运行相关单测；之后运行 `npm test` 和 `npm run build`。

## 验收标准

- 访问 `/admin?tab=日志` 时，动作、对象、详情和详情抽屉均以中文展示。
- 页面日志字段中不直接出现 `create_project`、`projects`、`project=12` 这类原始编码。
- 输入英文动作码仍能按原后端接口精确筛选日志。
- 历史日志、未知编码、空详情不会导致渲染错误。
- 新增单测、现有前端测试和生产构建均通过。
