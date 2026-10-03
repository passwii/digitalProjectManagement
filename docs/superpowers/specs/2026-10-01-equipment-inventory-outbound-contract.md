# 资产台账库存入库 / 出库 API 合同

本合同补齐 BLF-1214 前端接入所需的库存数据与出库能力。范围只覆盖设备台账的库存型入库和出库，不改变借用状态机；单件设备继续使用原生命周期能力。

## 鉴权

所有路由均要求登录。创建入库、出库操作沿用设备管理管理员权限。台账列表和流水查询沿用现有已登录用户读取权限。

## 入库：`POST /api/v1/equipment-assets/inbound`

保留原有批次选项及 `items` 字段，新增请求顶层 `inventory_managed`（布尔值，缺省 `false`）。`items` 中每个元素保留原有设备字段，新增 `quantity`（正整数，缺省 `1`）。

- 单件入库：`inventory_managed: false`；可按原合同一次登记多件独立设备；每件数量必须为 `1`，每台可保留独立序列号。
- 库存入库：`inventory_managed: true`；一次请求必须且只能包含一个物料元素，该元素的 `quantity` 为入库数量，不允许填写单件序列号或进入待验收批次。每次入库创建一条独立的库存记录，可指定已有 `batch_id` 或新批次 `name`。
- 库存记录的 `quantity` 是该入库来源累计入库量，`available_quantity` 是当前剩余可用量。初始两者相等；出库只扣减可用量，总入库量不变。
- 同一批次不允许混用单件设备和库存物料。

库存入库请求示例：

```json
{
  "name": "9月网线入库",
  "inventory_managed": true,
  "items": [{
    "name": "Cat6 网线",
    "category_code": "network",
    "quantity": 120,
    "brand": "示例品牌",
    "model": "Cat6",
    "note": "仓库入库"
  }]
}
```

返回值延续入库批次对象，包含 `batch_id`、`inventory_managed` 和 `items`。库存元素返回 `id`（库存来源记录 ID）、`batch_id`、`quantity`、`available_quantity`、`inventory_managed: true` 等台账字段。常见错误：400（数量/模式/序列号/待验收不匹配），403（无设备管理权限）。

原单件批量请求（`inventory_managed` 缺省或 `false`）继续有效；每项返回的 `quantity` / `available_quantity` 为 1，`inventory_managed` 为 `false`。

## 出库：`POST /api/v1/equipment-assets/{asset_id}/outbound`

请求体：

```json
{
  "quantity": 5,
  "customer": "客户名称",
  "destination": "客户机房 / 项目现场",
  "shipped_at": "2026-10-01T14:30:00+08:00",
  "note": "可选备注"
}
```

`quantity` 必须为正整数且不大于当前 `available_quantity`；`customer`、`destination` 至少填写一项；`shipped_at` 为实际发出时间（ISO 8601，带时区时按应用北京时间存储）；`note` 可选。仅库存型且可用状态的记录可以出库。扣减数量与新增流水及审计记录在同一事务提交；库存不足、普通单件记录、状态不允许或必填去向缺失时返回 400，权限不足返回 403。成功响应为出库流水，字段包含 `id`、`asset_id`、`batch_id`、`action: "outbound"`、`quantity`、`customer`、`destination`、`shipped_at`、`actor_id`、`created_at` 及扣减后的 `available_quantity`。

服务端会对库存记录行加锁并检查余量，避免并发出库造成超扣。数据库检查约束同时校验库存边界与完整的出库流水字段。

## 出库流水查询：`GET /api/v1/equipment-assets/outbounds`

查询参数：`asset_id` 可选；`page` 缺省 1；`size` 缺省 20、最大 100。返回标准分页 `{ total, page, size, items }`，按 `shipped_at` 倒序。每项含完整出库流水，以及 `asset_name`、`asset_code` 和当前 `available_quantity`。单条库存的全部生命周期流水也可继续通过 `GET /api/v1/equipment-assets/{asset_id}/events` 获取。

## 台账字段与历史兼容

`GET /api/v1/equipment-assets`、单条详情、批次详情/入库响应都返回 `quantity`、`available_quantity`、`inventory_managed`。旧有记录经迁移默认保持单件语义（数量 1、非库存型）；不会根据名称或批次猜测并自动合并存量设备。库存入库 / 出库流水为追加式记录，库存来源记录不支持永久删除。既有借用和单件生命周期 API 不变；库存记录不支持单件领用、借用、归还、维修、报废等状态流转。
