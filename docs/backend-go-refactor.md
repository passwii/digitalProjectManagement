# 数科云办公后端 Go (Gin + GORM) 全局重构架构与实施规范

本文档为数科云办公（digitalProjectManagement）后端从 Python FastAPI 全局推倒重构为 Go 模块化单体的完整架构设计、分阶段规范、Subagent 并行分工体系与交付验证文档。

---

## 一、架构概览与技术选型

### 1.1 核心选型
- **编程语言**：Go 1.24+
- **Web 框架**：Gin (`github.com/gin-gonic/gin`)
- **数据访问与 ORM**：GORM (`gorm.io/gorm`) + `gorm.io/driver/postgres` (`pgx/v5` 驱动)
- **数据库**：PostgreSQL 18（100% 保持 44 张业务表结构、主键、外键约束与索引完全兼容）
- **对象存储**：Cloudflare R2（通过 AWS SDK for Go v2 `github.com/aws/aws-sdk-go-v2/service/s3`），本地开发测试支持临时暂存目录
- **认证安全**：JWT HS256 (`github.com/golang-jwt/jwt/v5`)，单会话版本控制与黑名单；`golang.org/x/crypto/bcrypt` 密码散列
- **表格处理**：Excelize v2 (`github.com/xuri/excelize/v2`)，原生支持带公式防护的 XLSX/CSV 导入导出
- **高精度计算**：`github.com/shopspring/decimal`，杜绝复式记账浮点误差

### 1.2 目录组织规范
后端统一收敛在 `api/` 根目录下，形成标准 Go 模块化单体：
```text
api/
├── go.mod / go.sum
├── main.go                     # 主程序入口、配置自检、存储初始化、CORS 与路由装配
├── cmd/
│   └── seed/                   # 初始超管账号、角色、字典与系统参数种子填充程序
├── pkg/                        # 平台基础设施（无业务依赖的通用纯逻辑）
│   ├── config/                 # 环境变量解析、生产密钥强制校验与存储后端自检
│   ├── database/               # GORM DB 连接池配置 (Asia/Shanghai 驱动会话)
│   ├── timeutil/               # 北京时间 (Asia/Shanghai) Naive DB 转换与 ISO8601 输出
│   ├── paging/                 # 统一信封 {"total","page","size","items"} 与排序白名单
│   ├── validator/              # 数值/日期/枚举纯函数校验（拒绝 NaN/Infinity）
│   ├── audit/                  # 原子审计 (CommitAudited 业务+时间线+通知+审计单事务)
│   ├── storage/                # Cloudflare R2 S3 协议上传/下载/删除与本地临时暂存
│   ├── security/               # JWT HS256 严格签发/验签与 bcrypt 密码哈希
│   └── excel/                  # 基于 excelize/v2 的安全 Excel/CSV 导入导出引擎
├── internal/                   # 业务领域模块（内聚各领域 Handler、Service、Model、Repo）
│   ├── model/                  # 44 张数据库表结构定义（无循环引用）
│   ├── rbac/                   # 8大功能模块、超级管理员判断、项目数据全局范围策略
│   ├── auth/                   # 登录、注销、Token刷新、改密、黑名单
│   ├── meta/                   # 人员字典、部门、系统参数、动态前端菜单
│   ├── admin/                  # 用户管理、参数配置、演示数据开关、审计日志
│   ├── project/                # 项目台账、软删除回收站、变更留痕、成员管理、跟进提醒
│   ├── task/                   # WBS任务树 (DAG环检测、层级<=5)、进度日志(追加只增)
│   ├── milestone/              # 里程碑计划与状态维护
│   ├── budget/                 # 预算管理、预算调整申请、审批时间线
│   ├── expense/                # 支出录入、凭证附件、审批流转、重提闭环
│   ├── receivable/             # 项目应收台账与逐笔回款流水
│   ├── approval/               # 审批待办 pending 聚合、时间线查询与决策流转
│   ├── dashboard/              # 汇总统计、健康度评分、周报
│   ├── report/                 # 成本汇总报表、预警中心
│   ├── notify/                 # 站内通知去重时间窗口、四类预警定时聚合任务
│   ├── contact/                # 通讯录档案、独立名录、身份证脱敏与附件
│   ├── partner/                # 我的友商、业绩合同子表、资质附件
│   ├── opportunity/            # 商机漏斗与阶段流转
│   ├── equipment/              # 设备资产单件vs批量库存、状态机、出库行锁、事件流
│   └── finance/                # 复式记账引擎 (账套/期间/科目树/凭证/现金/银行/资产折旧/往来核销/报表)
└── legacy_py/                  # 归档的原 Python FastAPI 代码，作为行为基线对照
```

---

## 二、Paseo Subagent 并行协作分工体系

为了实现高吞吐、零冲突的批量重构，采用**基于业务领域的水平切分架构**。各兵团拥有完全解耦的目录写入权限，使用指定的高推理模型并行推进。

### 2.1 Subagent 角色矩阵

| 兵团代号 | Subagent 角色 | 驱动模型配置 | 独占写入目录范围 | 职责与交付物 |
|---|---|---|---|---|
| **Platform** | 平台底座专家 | `deepseek-v4.1-flash` (max) | `api/pkg/*`<br>`api/internal/model`<br>`api/internal/rbac`<br>`api/internal/auth`<br>`api/internal/meta`<br>`api/internal/admin`<br>`api/cmd/seed` | 1. 核心工具包封装<br>2. 全表 GORM 模型建立<br>3. JWT、RBAC 门禁、管理端接口与初始化种子 |
| **Army A** | 项目执行专家 (`Agent-Project`) | `deepseek-v4.1-flash` (max) | `api/internal/project`<br>`api/internal/task`<br>`api/internal/milestone`<br>`api/internal/budget`<br>`api/internal/expense`<br>`api/internal/receivable`<br>`api/internal/approval`<br>`api/internal/dashboard`<br>`api/internal/report`<br>`api/internal/notify` | 1. 项目立项/审批/进行/归档状态机<br>2. 任务 DAG 树（层级<=5、成环校验）<br>3. 进度日志 append-only 追加<br>4. 预算调整与支出审批闭环（超预算拦截）<br>5. 项目应收与回款行锁<br>6. 审批待办 pending 聚合（无 N+1） |
| **Army B** | CRM 协同专家 (`Agent-CRM`) | `deepseek-v4.1-flash` (max) | `api/internal/contact`<br>`api/internal/partner`<br>`api/internal/opportunity` | 1. 通讯录档案与 User 账号姓名/部门联动<br>2. 身份证号列表脱敏与分类附件管理<br>3. 友商档案与业绩合同子表级联<br>4. 商机管理漏斗阶段流转与编号自动生成 |
| **Army C** | 设备资产专家 (`Agent-Assets`) | `deepseek-v4.1-flash` (max) | `api/internal/equipment` | 1. 单件资产生命周期状态机（领用/借用/归还/送修/报废）<br>2. 批量库存模式（`inventory_managed=true`）<br>3. 出库严格行锁校验与库存扣减<br>4. 设备变更流水追加触发器兼容与清空门禁<br>5. Excelize 实现台账导入导出与公式注入防护 |
| **Army D** | 复式财务专家 (`Agent-Finance`) | `deepseek-v4.1-flash` (max) | `api/internal/finance` | 1. 账套管理与 1-13 期间结账/反结账乐观锁<br>2. 1-4 级科目树借贷方向与期初余额平衡<br>3. 凭证生命周期 (draft->pending->posted / void / reverse)<br>4. 往来 AR/AP FIFO 自动与手工核销分配、账龄分析<br>5. 固定资产折旧、银行流水对账匹配<br>6. 三张财务报表（资产负债表、利润表、现金流量表）与期末结转损益 |
| **Reviewer** | 审查仲裁专家 (`Agent-Review`) | `gemini-3.8-flash` | 全局只读审查 | 1. API 契约与 HTTP 语义核对<br>2. 权限与安全边界审查<br>3. 数据库事务原子性与并发行锁审计<br>4. 工具链统一性与测试通过性断言 |

---

## 三、五大核心业务域契约与规则规范

### 3.1 平台底座与认证安全
- **时间约定**：所有数据库 `timestamp without time zone` 列必须存储 `Asia/Shanghai` 墙钟时间（通过 `pkg/timeutil.DateTime` 的 Value/Scan 自动处理），HTTP 响应统一输出带 `+08:00` 的 ISO8601 字符串；JWT `exp` 保持 UTC epoch。
- **分页信封**：所有列表接口返回 `{"total": int, "page": int, "size": int, "items": [...]}`。`page >= 1`，`size 1..100`（默认 20），排序白名单最多 3 个字段，未显式指定 `id` 时自动追加 `id ASC` 保证翻页稳定性。
- **RBAC 授权**：
  - 系统唯一管理身份为 `User.is_super_admin`；历史 `Role` 仅作兼容展示。
  - 功能模块目录：`opportunities`, `projects`, `assets`, `reports`, `contacts`, `partners`, `approvals`, `finance`。
  - 项目全局范围：具备 `opportunities/projects/assets/reports` 任一模块即获得跨部门、跨项目全局读写；未分配者仅可读写自己负责或参与的项目。
  - 演示数据隔离：`sys_params.demo_data_on` 为 0 时，演示项目全站自动过滤。
- **原子审计**：关键写操作统一调用 `pkg/audit.CommitAudited`，业务行、时间线、站内通知与审计行必须同事务提交；审计写入失败整体回滚并返回 500。

### 3.2 项目台账、任务与审批
- **项目生命周期**：
  `draft -> pending (审批开) | filed | cancelled`
  `filed -> doing | cancelled`
  `doing -> paused | done`
  `done -> archived (负责人/超管)`
  `archived -> doing (仅超管)`
- **任务树约束**：
  - WBS 树父任务层级不得超过 5 级，且必须同项目。
  - 前置依赖链严格校验，禁止成环；前置未完成时后继任务不得标为 `done` 或进度填报 100%。
  - 任务权重严格大于 0；进度必须在 0-100 之间。
- **进度日志**：`progress_logs` 仅允许追加（POST），禁止编辑与删除（PATCH/DELETE 返回 405）。
- **预算与支出审批**：
  - 预算调整申请记录时间线；`budget_approval_on=0` 自动生效（auto_approve）。
  - 支出审批支持驳回（必填 reason）、特批（exception，必填 reason）；驳回后申请人可重新提交（`resubmit_count + 1`）。

### 3.3 设备资产与库存流转
- **单件模式 vs 批量库存**：
  - 单件设备（`inventory_managed=false`）：`quantity=1`，`available_quantity=1`，支持独立序列号与领用/借用/送修/报废状态机。
  - 批量库存（`inventory_managed=true`）：一条记录代表一个入库批次物料，`quantity` 为入库量，`available_quantity` 为可用量，只支持出库（outbound），禁止单件领用。
- **出库行锁**：出库必须在事务内锁行（`SELECT ... FOR UPDATE`），校验 `available_quantity >= req.quantity`，扣减余额并记录 `EquipmentEvent`。
- **Excel 安全**：导入导出强制对 `= + - @` 前导字符添加单引号防护，防止 CSV 注入；XLSX 使用 `excelize.Options{UnzipSizeLimit: 100MB}` 拦截解压炸弹。

### 3.4 复式记账财务系统
- **借贷平衡**：每张凭证至少两行分录，单行分录借贷必须单边，全凭证借方合计严格等于贷方合计。
- **金额精度**：金额统一使用 `decimal.Decimal`（映射 PG `numeric(18,2)`），杜绝任何 float64 精度损失。
- **会计期间**：支持 1-13 会计期间（第 13 期为调整期）。结账时严格检查未过账凭证、草稿凭证、断号、期初平衡与未结现金流；期末自动将损益科目结转至 3103“本年利润”凭证。

---

## 四、容器化与 CI/CD 交付标准

### 4.1 多阶段 Dockerfile (`docker/api.Dockerfile`)
- **构建阶段**：`golang:1.24-alpine`，静态编译 `CGO_ENABLED=0 GOOS=linux`，生成 `/app/server` 和 `/app/seed` 二进制。
- **运行阶段**：`python:3.14-slim`，保留轻量 Python 运行底座以无缝执行 `alembic upgrade head` 迁移脚本，随后启动 Go 编译产物。
- **端口与健康检查**：对外暴露 `8001`，健康检查探针请求 `http://127.0.0.1:8001/health`。

### 4.2 GitHub Actions 流水线 (`.github/workflows/api.yml`)
1. 启动 `postgres:18` 服务容器。
2. 安装 Go 1.24 环境与 Python 3.14 依赖。
3. 执行 `cd api && go test -v ./...` 运行全量 Go 单元与集成测试。
4. 执行 `pytest tests/test_migration_revision_ids.py -q` 守卫数据库迁移链完整性。

---

## 五、验证与自检清单 (Verification Checklist)

- [x] `api/` 目录下 Go 模块初始化完成 (`go.mod` 对齐 `go 1.24`)
- [x] 所有 44 张数据表在 `internal/model` 映射完毕
- [x] 平台基础设施 (`pkg/timeutil`, `pkg/paging`, `pkg/security`, `pkg/audit`, `pkg/storage`, `pkg/validator`, `pkg/excel`, `pkg/config`, `pkg/database`) 单测全绿
- [x] 18 个领域包业务路由全量注册并在 `main.go` 挂载
- [x] 设备资产模块修复 Excel 日期年份容错、千亿级金额溢出保护与解压炸弹限制
- [x] 报表与项目应收路由全量补齐 `PROJECT_SCOPE_MODULES` 门禁
- [x] JWT 验签严格限制 `HS256` 签名算法
- [x] 生产配置强制校验 `APP_SECRET` 强度，拒绝默认密钥
- [x] `cd api && go test ./...` 全包测试 100% 通过
- [x] `cd api && go build -o /dev/null main.go` 构建完全成功
- [x] `pytest tests/test_migration_revision_ids.py -q` 迁移链测试全绿通过
- [x] 前端 Next.js (`web/`) 运行 `npm test`（1,073 个测试）全绿通过
- [x] 前端 Next.js (`web/`) 运行 `npm run build` 静态编译成功
