"use client";

import { Confirm } from "@/components/ui/Modal";
import type { Project } from "@/lib/api";

/**
 * 项目软删除的两步确认弹窗。
 *
 * 删除是危险操作：第一步说明影响（移入回收站、关联数据保留、仅管理员可恢复），
 * 用户点「继续删除」后才进入第二步，第二步点「确认删除」才真正执行。
 * 两个弹窗都是 `danger`，把「误点一次」挡在真正删除之前。
 *
 * 弹窗的开关与当前步骤由调用方（项目台账页）持有，本组件只负责呈现，
 * 这样页面里多个删除入口（列表行、详情抽屉、编辑弹窗）可以复用同一流程。
 */
export function ProjectDeleteDialogs({
  target,
  step,
  busy,
  onNextStep,
  onConfirm,
  onCancel,
}: {
  /** 待删除项目；为空时不显示任何弹窗 */
  target: Project | null;
  /** 1 = 第一步（说明影响）；2 = 第二步（最终确认）；null = 关闭 */
  step: 1 | 2 | null;
  busy?: boolean;
  onNextStep: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <Confirm
        open={!!target && step === 1}
        danger
        title={`删除项目「${target?.name ?? ""}」？`}
        text={
          target && (
            <>
              项目 <b>{target.name}</b>（
              <span className="mono">{target.code}</span>）
              将移入回收站，关联的任务、支出、附件、跟进与审批记录全部保留，
              仅管理员可在「系统管理 → 回收站」恢复。
              <br />
              为防误删，下一步还需再确认一次。
            </>
          )
        }
        okText="继续删除"
        onConfirm={onNextStep}
        onCancel={onCancel}
      />
      <Confirm
        open={!!target && step === 2}
        danger
        loading={busy}
        title={`再次确认删除「${target?.name ?? ""}」`}
        text={
          target && (
            <>
              请最终确认要删除项目 <b>{target.name}</b>（
              <span className="mono">{target.code}</span>）。
              删除后项目从台账与各业务列表消失，数据进入回收站，仅管理员可恢复。
            </>
          )
        }
        okText="确认删除"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </>
  );
}
