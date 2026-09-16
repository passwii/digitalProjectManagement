"use client";
// 系统参数编辑弹窗
import { useEffect } from "react";
import { adminApi } from "@/lib/api";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

export const PARAM_LABELS: Record<string, string> = {
  login_fail_limit: "登录失败锁定阈值（次）",
  login_lock_minutes: "锁定时长（分钟）",
  budget_warn_rate: "预算执行率预警线（0-1）",
  budget_approval_on: "预算调整审批开关（0关/1开）",
  expense_approval_on: "支出审批开关（0关/1开）",
  milestone_warn_days: "里程碑预警天数",
  stagnant_days: "项目停滞无填报天数",
  demo_data_on: "演示数据开关（0隐藏/1显示）",
};

export const PARAM_HINTS: Record<string, string> = {
  login_fail_limit: "连续失败达到该次数后锁定账号",
  login_lock_minutes: "锁定时长，到期自动解锁",
  budget_warn_rate: "0.8 表示执行率达 80% 触发预警",
  budget_approval_on: "1 = 预算调整需审批",
  expense_approval_on: "1 = 支出需审批后才计入执行；超预算时转为待审批",
  milestone_warn_days: "里程碑计划日期前 N 天开始预警",
  stagnant_days: "项目连续 N 天无进度填报则判为停滞",
  demo_data_on: "1=在项目台账等页面显示演示数据；0=全站隐藏（含工作台与报表统计）",
};

export default function ParamDialog({
  open,
  onClose,
  paramKey,
  value,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  paramKey: string;
  value: string;
  onSaved: () => void;
}) {
  const form = useForm<{ value: string }>({ value }, {
    value: { required: "参数值不能为空", label: "参数值" },
  });

  useEffect(() => {
    if (open) form.reset({ value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paramKey, value]);

  async function submit() {
    if (!form.validate()) return;
    await adminApi.setParams({ [paramKey]: form.values.value.trim() });
    onSaved();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title={`编辑参数 · ${PARAM_LABELS[paramKey] ?? paramKey}`}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>保存参数</button>
        </>
      }
    >
      <div className="form-grid one">
        <Field label="参数键">
          <input value={paramKey} disabled className="mono" />
        </Field>
        <Field label="参数值" required error={form.errors.value} hint={PARAM_HINTS[paramKey]}>
          <input
            value={form.values.value}
            aria-invalid={!!form.errors.value}
            onChange={(e) => form.set("value", e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
