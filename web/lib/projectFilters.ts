import { buildQuery } from "./api";

/**
 * 负责人筛选的取值口径 = **姓名**（台账「负责人」列的展示值）。
 *
 * 为什么不是 `owner_id`：
 * · 建档时如果负责人没有登录账号，后端会把 `owner_id` 落成**创建人**的 id
 *   （`api/routers/projects.py::create_project`，用于让创建人保有项目访问权），
 *   于是「按 id 筛」选谁都像是创建人的项目 —— 表现就是「筛选后还是全部结果」；
 * · 没有账号的负责人（演示数据、历史数据）不在账号字典里，根本选不出来。
 *
 * `owner_name` 才是列表里真正显示的值。后端 `GET /projects?owner=<姓名>`（BLF-1148）
 * 同时匹配 `owner_name` 精确相等与同名账号的 `owner_id`，是唯一「看到什么就筛出什么」的条件。
 */
export function normalizeProjectOwnerName(raw: string | number | null | undefined): string {
  return String(raw ?? "").trim();
}

export interface ProjectListQueryParams {
  page: number;
  size: number;
  sort: string;
  keyword?: string;
  status?: string;
  owner?: string | number | null;
  code?: string;
}

/** 项目台账列表查询的唯一组装入口，锁定 URL → `/projects` 的参数契约。 */
export function buildProjectListQuery(params: ProjectListQueryParams): string {
  return buildQuery({
    page: params.page,
    size: params.size,
    sort: params.sort,
    keyword: params.keyword,
    status: params.status,
    owner: normalizeProjectOwnerName(params.owner),
    code: params.code,
  });
}
