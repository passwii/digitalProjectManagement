"use client";
// 用户新增/编辑弹窗：角色多选（并集）、可重置密码
import { useEffect, useState } from "react";
import { adminApi, type AdminUser } from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

interface Values {
  username: string;
  real_name: string;
  dept_id: string;
  password: string;
}

const BLANK: Values = { username: "", real_name: "", dept_id: "", password: "123456" };

export default function UserDialog({
  open,
  onClose,
  user,
  roles,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  user: AdminUser | null;
  roles: { id: number; code: string; name: string }[];
  onSaved: (isNew: boolean) => void;
}) {
  const { depts } = useMeta();
  const isEdit = !!user;
  const [picked, setPicked] = useState<string[]>([]);

  const form = useForm<Values>(
    isEdit && user
      ? { username: user.username, real_name: user.real_name, dept_id: user.dept_id ? String(user.dept_id) : "", password: "" }
      : BLANK,
    {
      username: {
        label: "账号",
        required: "账号不能为空",
        pattern: /^[A-Za-z0-9_.-]{3,32}$/,
        custom: (v) => (/^[A-Za-z0-9_.-]{3,32}$/.test(String(v)) ? null : "账号需 3-32 位字母、数字或 _ . -"),
      },
      password: {
        label: "密码",
        custom: (v) => {
          if (isEdit && !v) return null; // 编辑时留空表示不改
          const s = String(v);
          if (s.length < 6) return "密码至少 6 位";
          return null;
        },
      },
    }
  );

  useEffect(() => {
    if (!open) return;
    setPicked(user ? user.roles.map((r) => r.code) : []);
    form.reset(
      user
        ? { username: user.username, real_name: user.real_name, dept_id: user.dept_id ? String(user.dept_id) : "", password: "" }
        : BLANK
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.id]);

  async function submit() {
    if (!form.validate()) return;
    if (picked.length === 0) {
      form.setErrors({ real_name: "请至少选择一个角色" });
      return;
    }
    const v = form.values;
    if (isEdit) {
      const payload: Record<string, unknown> = {
        real_name: v.real_name,
        dept_id: v.dept_id ? Number(v.dept_id) : null,
        roles: picked,
      };
      if (v.password) payload.password = v.password;
      await adminApi.updateUser(user!.id, payload);
    } else {
      await adminApi.createUser({
        username: v.username,
        password: v.password || "123456",
        real_name: v.real_name,
        dept_id: v.dept_id ? Number(v.dept_id) : null,
        roles: picked,
      });
    }
    onSaved(!isEdit);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty || (!!user && JSON.stringify(picked) !== JSON.stringify(user.roles.map((r) => r.code)))}
      title={isEdit ? `编辑用户 · ${user?.username ?? ""}` : "新增用户"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>{isEdit ? "保存修改" : "创建用户"}</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="登录账号" required error={form.errors.username} hint={isEdit ? "账号创建后不可修改" : undefined}>
          <input
            value={form.values.username}
            disabled={isEdit}
            aria-invalid={!!form.errors.username}
            onChange={(e) => form.set("username", e.target.value)}
            placeholder="如：zhangsan"
          />
        </Field>
        <Field label="姓名">
          <input value={form.values.real_name} onChange={(e) => form.set("real_name", e.target.value)} placeholder="显示名称" />
        </Field>
        <Field label="所属部门">
          <select value={form.values.dept_id} onChange={(e) => form.set("dept_id", e.target.value)}>
            <option value="">未设置</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label={isEdit ? "重置密码" : "初始密码"} error={form.errors.password} hint={isEdit ? "留空表示不修改" : "默认 123456"}>
          <input
            type="text"
            value={form.values.password}
            aria-invalid={!!form.errors.password}
            onChange={(e) => form.set("password", e.target.value)}
            placeholder={isEdit ? "留空不修改" : "123456"}
          />
        </Field>
        <Field label="角色（可多选，权限取并集）" required error={form.errors.real_name} span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 2 }}>
            {roles.map((r) => {
              const on = picked.includes(r.code);
              return (
                <button
                  key={r.code}
                  type="button"
                  className={on ? "btn-primary" : "btn-ghost"}
                  style={{ width: "auto", height: 28, lineHeight: "26px", fontSize: 12 }}
                  onClick={() =>
                    setPicked((prev) => (prev.includes(r.code) ? prev.filter((c) => c !== r.code) : [...prev, r.code]))
                  }
                >
                  {on ? "✓ " : ""}{r.name}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
      {isEdit && <p className="tiny">仅管理员可编辑用户；改密后该用户下次登录需使用新密码。</p>}
    </Dialog>
  );
}
