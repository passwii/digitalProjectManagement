import { buildQuery } from "./api";

/** 后端没有负责人时使用 0；因此非法 URL 值不能直接省略 owner_id，否则会退化为全量。 */
export const INVALID_OWNER_ID = -1;

/**
 * 将项目台账 URL 中的负责人值转换为后端 `owner_id`。
 *
 * 负责人下拉写入的是用户 ID，不是姓名。只接受正的安全整数；非法值映射
 * 到一个不可能命中的 ID，让后端返回空列表，而不是因为参数被跳过而返回全部项目。
 * 合法但已不存在的用户 ID 则由后端精确过滤，同样不会退化为全量。
 */
export function normalizeProjectOwnerId(raw: string | number | null | undefined): number | "" {
  if (raw === null || raw === undefined || String(raw).trim() === "") return "";
  const value = String(raw).trim();
  if (!/^[1-9]\d*$/.test(value)) return INVALID_OWNER_ID;

  const id = Number(value);
  return Number.isSafeInteger(id) ? id : INVALID_OWNER_ID;
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
    owner_id: normalizeProjectOwnerId(params.owner),
    code: params.code,
  });
}
