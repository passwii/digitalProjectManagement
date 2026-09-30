"use client";
// 用户新增/编辑弹窗：功能模块分配（Stage 5，可多选）、可重置密码
import { useEffect, useState } from "react";
import { adminApi, type AdminUser, type ModuleItem } from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";
import Select from "@/components/ui/Select";

interface Values {
  username: string;
  real_name: string;
  dept_id: string;
  password: string;
}

const BLANK: Values = { username: "", real_name: "", dept_id: "", password: "admin123456" };

// 新用户的默认模块：与后端 DEFAULT_MODULES 对齐（四个基础导航模块），超级管理员可再增减。
const DEFAULT_MODULE_KEYS = ["opportunities", "projects", "assets", "reports"];

export default function UserDialog({
  open,
  onClose,
  user,
  modules,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  user: AdminUser | null;
  roles: { id: number; code: string; name: string }[];
  modules: ModuleItem[];
  onSaved: (isNew: boolean) => void;
}) {
  const { depts } = useMeta();
  const isEdit = !!user;
  const [pickedModules, setPickedModules] = useState<string[]>([]);

  const form = useForm<Values>(
    isEdit && user
      ? { username: user.username, real_name: user.real_name, dept_id: user.dept_id ? String(user.dept_id) : "", password: "" }
      : BLANK,
    {
      username: {
        label: "登录手机号",
        required: "登录手机号不能为空",
        custom: (v) => (/^1\d{10}$/.test(String(v)) ? null : "请输入 11 位手机号"),
      },
      password: {
        label: "密码",
        custom: (v) => {
          if (isEdit && !v) return null; // 编辑时留空表示不改
          const s = String(v);
          if (s.length < 8 || !/[A-Za-z]/.test(s) || !/\d/.test(s)) {
            return "初始密码至少 8 位且需同时包含字母与数字";
          }
          return null;
        },
      },
    }
  );

  useEffect(() => {
    if (!open) return;
    setPickedModules(
      user
        ? user.modules
        : DEFAULT_MODULE_KEYS.filter((k) => modules.some((m) => m.key === k))
    );
    form.reset(
      user
        ? { username: user.username, real_name: user.real_name, dept_id: user.dept_id ? String(user.dept_id) : "", password: "" }
        : BLANK
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.id]);

  async function submit() {
    if (!form.validate()) return;
    const v = form.values;
    if (isEdit) {
      const payload: Record<string, unknown> = {
        real_name: v.real_name,
        dept_id: v.dept_id ? Number(v.dept_id) : null,
        modules: pickedModules,
      };
      if (v.password) payload.password = v.password;
      await adminApi.updateUser(user!.id, payload);
    } else {
      await adminApi.createUser({
        username: v.username,
        password: v.password || "admin123456",
        real_name: v.real_name,
        dept_id: v.dept_id ? Number(v.dept_id) : null,
        modules: pickedModules,
      });
    }
    onSaved(!isEdit);
    onClose();
  }

  const modulesDirty =
    !!user && JSON.stringify(pickedModules) !== JSON.stringify(user.modules);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty || modulesDirty}
      title={isEdit ? `编辑用户 · ${user?.username ?? ""}` : "新增用户"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>{isEdit ? "保存修改" : "创建用户"}</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="登录手机号" required error={form.errors.username} hint={isEdit ? "手机号创建后不可修改" : "其他账号仅可由管理员签发"}>
          <input
            value={form.values.username}
            disabled={isEdit}
            aria-invalid={!!form.errors.username}
            onChange={(e) => form.set("username", e.target.value)}
            placeholder="如：15796280534"
          />
        </Field>
        <Field label="姓名">
          <input value={form.values.real_name} onChange={(e) => form.set("real_name", e.target.value)} placeholder="显示名称" />
        </Field>
        <Field label="所属部门">
          <Select value={form.values.dept_id} onChange={(value) => form.set("dept_id", value)}>
            <option value="">未设置</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label={isEdit ? "重置密码" : "初始密码"} error={form.errors.password} hint={isEdit ? "重置后用户下次登录必须改密" : "用户首次登录必须修改密码"}>
          <input
            type="text"
            value={form.values.password}
            aria-invalid={!!form.errors.password}
            onChange={(e) => form.set("password", e.target.value)}
            placeholder={isEdit ? "留空不修改" : "admin123456"}
          />
        </Field>
        <Field
          label="功能模块（可多选，决定该用户可见页面与可访问接口）"
          hint="超级管理员的模块分配不影响其全量权限；财务页面沿用账套成员授权。普通用户未分配任何模块时仅能进入工作台。"
          span
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 2 }}>
            {modules.map((mod) => {
              const on = pickedModules.includes(mod.key);
              return (
                <button
                  key={mod.key}
                  type="button"
                  className={`${on ? "btn-primary" : "btn-ghost"} btn-xs`}
                  aria-pressed={on}
                  onClick={() =>
                    setPickedModules((prev) =>
                      prev.includes(mod.key) ? prev.filter((k) => k !== mod.key) : [...prev, mod.key]
                    )
                  }
                >
                  {on ? "✓ " : ""}{mod.label}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
      {isEdit && <p className="tiny">仅超级管理员可编辑用户；改密后该用户下次登录需使用新密码。</p>}
    </Dialog>
  );
}
