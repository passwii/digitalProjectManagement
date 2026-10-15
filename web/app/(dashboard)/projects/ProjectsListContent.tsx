"use client";

import type { Project } from "@/lib/api";
import Badge from "@/components/ui/Badge";
import Avatar from "@/components/ui/Avatar";
import Pagination, { type PaginationChange } from "@/components/ui/Pagination";
import { CardItem, CardList } from "@/components/ui/CardList";
import {
  DesktopTableFrame,
  ListViewport,
} from "@/components/ui/ListPageLayout";
import MotionReveal from "@/components/motion/MotionReveal";
import {
  CONTRACT_STATUS,
  fmtMoney,
  contractStatusLabel,
  projectStatusLabel,
  projectTone,
} from "@/lib/labels";

export type ProjectsListContentProps = {
  items: Project[];
  page: number;
  size: number;
  total: number;
  loading: boolean;
  scopeText: string;
  onPageChange: (next: PaginationChange) => void;
  onSelect?: (project: Project) => void;
  onEdit?: (project: Project) => void;
  /** 是否展示「删除」入口（仅管理员，权限口径与后端 require_admin 一致） */
  canDelete?: boolean;
  /** 点击「删除」：交由页面走两步确认后执行软删除 */
  onDelete?: (project: Project) => void;
  ownerText?: (project: Project) => string;
};

const SIZE_OPTIONS = [15, 50, 100];

export function ProjectsListContent({
  items,
  page,
  size,
  total,
  loading,
  scopeText,
  onPageChange,
  onSelect,
  onEdit,
  canDelete = false,
  onDelete,
  ownerText = (project) => project.owner_name || String(project.owner_id),
}: ProjectsListContentProps) {
  return (
    <ListViewport
      pagination={
        <Pagination
          page={page}
          size={size}
          total={total}
          loading={loading}
          sizeOptions={SIZE_OPTIONS}
          scopeText={scopeText}
          ariaLabel="项目台账分页"
          onChange={onPageChange}
        />
      }
    >
      <MotionReveal delay={0.08}>
        <CardList label="项目台账">
          {items.map((p) => (
            <CardItem
              key={p.id}
              title={
                <span className="ellipsis" title={p.name}>
                  {p.name}
                </span>
              }
              code={p.code}
              badges={
                <>
                  <Badge
                    status={projectStatusLabel(p.status)}
                    tone={projectTone(p.status)}
                  />
                  <Badge
                    status={
                      p.contract_status
                        ? contractStatusLabel(p.contract_status)
                        : "未登记"
                    }
                    tone={
                      p.contract_status &&
                      CONTRACT_STATUS[p.contract_status] === "已签订"
                        ? "done"
                        : "todo"
                    }
                  />
                </>
              }
              fields={[
                {
                  label: "负责人",
                  value: (
                    <span className="inline-person">
                      <Avatar name={ownerText(p)} size={22} />
                      {ownerText(p)}
                    </span>
                  ),
                },
                {
                  label: "客户",
                  value: (
                    <span className="ellipsis" title={p.client}>
                      {p.client || "-"}
                    </span>
                  ),
                },
                {
                  label: "预算",
                  value: `${fmtMoney(p.budget_total)} 元`,
                  mono: true,
                },
              ]}
              actions={
                <>
                  <button
                    type="button"
                    className="btn-ghost btn-xs"
                    onClick={() => onEdit?.(p)}
                  >
                    编辑
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      className="btn-ghost btn-xs danger-link"
                      onClick={() => onDelete?.(p)}
                    >
                      删除
                    </button>
                  )}
                </>
              }
              onSelect={() => onSelect?.(p)}
            />
          ))}
        </CardList>
        <DesktopTableFrame>
          <table className="grid project-table" aria-busy={loading}>
            <colgroup>
              <col style={{ width: 150 }} />
              <col style={{ width: 250 }} />
              <col style={{ width: 104 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 84 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 84 }} />
              <col style={{ width: 110 }} />
            </colgroup>
            <thead>
              <tr>
                <th>编号</th>
                <th>名称</th>
                <th>负责人</th>
                <th>客户</th>
                <th>合同</th>
                <th className="num">合同金额（元）</th>
                <th>状态</th>
                <th className="no-print">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.id}
                  className="clickable-row"
                  onClick={() => onSelect?.(p)}
                  title="点击查看详情"
                >
                  <td className="mono project-code">{p.code}</td>
                  <td>
                    <span className="ellipsis" title={p.name}>
                      {p.name}
                    </span>{" "}
                  </td>
                  <td>
                    <span className="inline-person">
                      <Avatar name={ownerText(p)} size={22} />
                      {ownerText(p)}
                    </span>
                  </td>
                  <td className="muted">
                    <span className="ellipsis" title={p.client}>
                      {p.client || "-"}
                    </span>
                  </td>
                  <td>
                    <Badge
                      status={
                        p.contract_status
                          ? contractStatusLabel(p.contract_status)
                          : "未登记"
                      }
                      tone={
                        p.contract_status &&
                        CONTRACT_STATUS[p.contract_status] === "已签订"
                          ? "done"
                          : "todo"
                      }
                    />
                  </td>
                  <td className="num">{fmtMoney(p.budget_total)}</td>
                  <td>
                    <Badge
                      status={projectStatusLabel(p.status)}
                      tone={projectTone(p.status)}
                    />
                  </td>
                  <td className="no-print">
                    <span className="table-actions">
                      <button
                        className="btn-ghost btn-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect?.(p);
                        }}
                      >
                        查看
                      </button>
                      <button
                        className="btn-ghost btn-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit?.(p);
                        }}
                      >
                        编辑
                      </button>
                      {canDelete && (
                        <button
                          className="btn-ghost btn-xs danger-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete?.(p);
                          }}
                        >
                          删除
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DesktopTableFrame>
      </MotionReveal>
    </ListViewport>
  );
}
