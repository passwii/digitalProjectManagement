"use client";

import { useEffect, useState } from "react";
import {
  contactsApi,
  errText,
  type Contact,
  type ContactAttachment,
  type ContactAttachmentCategory,
} from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { useForm } from "@/lib/useForm";
import { ATTACHMENT_HINT, CONTACT_ATTACHMENT_ACCEPT } from "@/lib/uploadLimits";
import { Confirm, Drawer } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";

const EMPLOYMENT_TYPES = ["正式", "试用", "实习", "劳务", "兼职", "返聘"];
const EMPLOYMENT_STATUS = [
  { value: "active", label: "在职" },
  { value: "probation", label: "试用" },
  { value: "leave", label: "离职" },
];
const CONTRACT_TYPES = ["劳动合同", "劳务合同", "实习协议", "顾问协议", "其他"];
const CATEGORY_LABELS: Record<ContactAttachmentCategory, string> = {
  id_card: "身份证",
  education: "学历证书",
  degree: "学位证书",
  professional_cert: "专业证书",
  labor_contract: "劳动合同",
  other: "其他",
};

interface FormValues {
  real_name: string;
  mobile: string;
  user_id: string;
  dept_id: string;
  employee_no: string;
  position: string;
  manager_id: string;
  employment_type: string;
  employment_status: string;
  hire_date: string;
  regular_date: string;
  leave_date: string;
  work_email: string;
  office_phone: string;
  work_location: string;
  contract_type: string;
  contract_start: string;
  contract_end: string;
  gender: string;
  birth_date: string;
  id_card_no: string;
  native_place: string;
  political_status: string;
  marital_status: string;
  address: string;
  highest_education: string;
  school: string;
  major: string;
  graduation_date: string;
  degree: string;
  emergency_contact: string;
  emergency_relation: string;
  emergency_phone: string;
  remark: string;
}

const BLANK: FormValues = {
  real_name: "",
  mobile: "",
  user_id: "",
  dept_id: "",
  employee_no: "",
  position: "",
  manager_id: "",
  employment_type: "正式",
  employment_status: "active",
  hire_date: "",
  regular_date: "",
  leave_date: "",
  work_email: "",
  office_phone: "",
  work_location: "",
  contract_type: "",
  contract_start: "",
  contract_end: "",
  gender: "",
  birth_date: "",
  id_card_no: "",
  native_place: "",
  political_status: "",
  marital_status: "",
  address: "",
  highest_education: "",
  school: "",
  major: "",
  graduation_date: "",
  degree: "",
  emergency_contact: "",
  emergency_relation: "",
  emergency_phone: "",
  remark: "",
};

function toValues(contact: Contact): FormValues {
  return {
    real_name: contact.real_name || "",
    mobile: contact.mobile || "",
    user_id: contact.user_id ? String(contact.user_id) : "",
    dept_id: contact.dept_id ? String(contact.dept_id) : "",
    employee_no: contact.employee_no || "",
    position: contact.position || "",
    manager_id: contact.manager_id ? String(contact.manager_id) : "",
    employment_type: contact.employment_type || "正式",
    employment_status: contact.employment_status || "active",
    hire_date: contact.hire_date || "",
    regular_date: contact.regular_date || "",
    leave_date: contact.leave_date || "",
    work_email: contact.work_email || "",
    office_phone: contact.office_phone || "",
    work_location: contact.work_location || "",
    contract_type: contact.contract_type || "",
    contract_start: contact.contract_start || "",
    contract_end: contact.contract_end || "",
    gender: contact.gender || "",
    birth_date: contact.birth_date || "",
    id_card_no: contact.id_card_no || "",
    native_place: contact.native_place || "",
    political_status: contact.political_status || "",
    marital_status: contact.marital_status || "",
    address: contact.address || "",
    highest_education: contact.highest_education || "",
    school: contact.school || "",
    major: contact.major || "",
    graduation_date: contact.graduation_date || "",
    degree: contact.degree || "",
    emergency_contact: contact.emergency_contact || "",
    emergency_relation: contact.emergency_relation || "",
    emergency_phone: contact.emergency_phone || "",
    remark: contact.remark || "",
  };
}

function toPayload(values: FormValues): Record<string, unknown> {
  const dates = new Set([
    "hire_date", "regular_date", "leave_date", "contract_start", "contract_end",
    "birth_date", "graduation_date",
  ]);
  const payload: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const value = String(raw ?? "").trim();
    if (key === "dept_id" || key === "manager_id" || key === "user_id") {
      payload[key] = value ? Number(value) : null;
    } else if (dates.has(key)) {
      payload[key] = value || null;
    } else if (key === "employee_no") {
      payload[key] = value || null;
    } else if (key === "real_name") {
      payload.name = value;
    } else {
      payload[key] = value;
    }
  }
  return payload;
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 KB";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function ContactDrawer({
  contactId,
  onClose,
  onSaved,
}: {
  contactId: number | "new" | null;
  onClose: () => void;
  onSaved: (contact: Contact) => void;
}) {
  const { users, depts } = useMeta();
  const toast = useToast();
  const [contact, setContact] = useState<Contact | null>(null);
  const [attachments, setAttachments] = useState<ContactAttachment[]>([]);
  const [managerOptions, setManagerOptions] = useState<{ id: number; name: string }[]>([]);
  const [category, setCategory] = useState<ContactAttachmentCategory>("id_card");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [deleting, setDeleting] = useState<ContactAttachment | null>(null);

  const form = useForm<FormValues>(BLANK, {
    real_name: { required: "姓名不能为空", max: 64, label: "姓名" },
    employee_no: { max: 32, label: "工号" },
    work_email: {
      label: "工作邮箱",
      custom: (value) =>
        !value || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value))
          ? null
          : "工作邮箱格式不正确",
    },
    id_card_no: {
      label: "身份证号",
      custom: (value) =>
        !value || /^(?:\d{15}|\d{17}[\dXx])$/.test(String(value))
          ? null
          : "请输入 15 位或 18 位身份证号",
    },
  });

  useEffect(() => {
    if (!contactId) return;
    if (contactId === "new") {
      setContact(null);
      setAttachments([]);
      setFormErr("");
      setLoading(false);
      form.reset(BLANK);
      contactsApi.options().then(setManagerOptions).catch(() => setManagerOptions([]));
      return;
    }
    let alive = true;
    setLoading(true);
    setFormErr("");
    Promise.all([
      contactsApi.get(contactId),
      contactsApi.attachments(contactId),
      contactsApi.options(),
    ])
      .then(([detail, files, managers]) => {
        if (!alive) return;
        setContact(detail);
        form.reset(toValues(detail));
        setAttachments(files);
        setManagerOptions(managers);
      })
      .catch((e) => {
        if (alive) setFormErr(errText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  async function save() {
    if (!form.validate()) return;
    setSaving(true);
    setFormErr("");
    try {
      const payload = toPayload(form.values);
      const saved = contact
        ? await contactsApi.update(contact.id, payload)
        : await contactsApi.create(payload);
      setContact(saved);
      form.reset(toValues(saved));
      toast.ok(contact ? "通讯录档案已保存" : "通讯录人员已建档");
      onSaved(saved);
    } catch (e) {
      const message = errText(e);
      setFormErr(message);
      toast.err(message);
    } finally {
      setSaving(false);
    }
  }

  async function upload(file: File) {
    if (!contact) return;
    setUploading(true);
    setFormErr("");
    try {
      const row = await contactsApi.upload(contact.id, category, file);
      setAttachments((rows) => [row, ...rows]);
      setContact((current) =>
        current ? { ...current, attachment_count: current.attachment_count + 1 } : current
      );
      toast.ok("附件已上传");
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setUploading(false);
    }
  }

  async function removeAttachment() {
    if (!contact || !deleting) return;
    try {
      await contactsApi.deleteAttachment(contact.id, deleting.id);
      setAttachments((rows) => rows.filter((row) => row.id !== deleting.id));
      setContact((current) =>
        current
          ? { ...current, attachment_count: Math.max(0, current.attachment_count - 1) }
          : current
      );
      toast.ok("附件已删除");
      setDeleting(null);
    } catch (e) {
      toast.err(errText(e));
    }
  }

  const title = contact ? `通讯录档案 · ${contact.real_name}` : "新建通讯录人员";
  const managerChoices = managerOptions.filter((item) => item.id !== contact?.id);

  return (
    <>
      <Drawer
        open={contactId !== null}
        onClose={onClose}
        title={title}
        width={860}
        dirty={form.dirty}
        footer={
          <>
            <button className="btn-ghost" onClick={onClose} disabled={saving}>关闭</button>
            <button className="btn-primary" onClick={save} disabled={saving || loading}>
              {saving ? "保存中…" : contact ? "保存档案" : "保存并建档"}
            </button>
          </>
        }
      >
        {loading ? (
          <div className="skel skel-title" />
        ) : contactId !== "new" && !contact ? (
          <div className="err-banner" role="alert">{formErr || "档案加载失败"}</div>
        ) : (
          <>
            {formErr && <div className="err-banner" role="alert">{formErr}</div>}

            <div className="form-section">
              <div className="form-section-head">
                <div>
                  <h3>基础身份</h3>
                  <p>人员可无登录账号；关联账号后，姓名和部门会同步到该账号。</p>
                </div>
              </div>
              <div className="form-grid">
                <Field
                  label="关联登录账号"
                  hint={contact?.user_id ? `已关联：${contact.username}` : "无账号人员可不选择"}
                >
                  <select
                    value={form.values.user_id}
                    onChange={(e) => form.set("user_id", e.target.value)}
                  >
                    <option value="">不关联账号</option>
                    {users.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.real_name || account.username} · {account.username}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="姓名" required error={form.errors.real_name}>
                  <input
                    value={form.values.real_name}
                    aria-invalid={!!form.errors.real_name}
                    onChange={(e) => form.set("real_name", e.target.value)}
                  />
                </Field>
                <Field label="联系电话">
                  <input
                    value={form.values.mobile}
                    onChange={(e) => form.set("mobile", e.target.value)}
                    placeholder="无账号人员也可填写"
                  />
                </Field>
                <Field label="所属部门">
                  <select value={form.values.dept_id} onChange={(e) => form.set("dept_id", e.target.value)}>
                    <option value="">未设置</option>
                    {depts.map((dept) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
                  </select>
                </Field>
                <Field label="工号" error={form.errors.employee_no}>
                  <input
                    value={form.values.employee_no}
                    onChange={(e) => form.set("employee_no", e.target.value)}
                    placeholder="如 E001"
                  />
                </Field>
                <Field label="性别">
                  <select value={form.values.gender} onChange={(e) => form.set("gender", e.target.value)}>
                    <option value="">未填写</option>
                    <option value="男">男</option>
                    <option value="女">女</option>
                    <option value="未填写">其他/不便说明</option>
                  </select>
                </Field>
                <Field label="出生日期">
                  <input type="date" value={form.values.birth_date} onChange={(e) => form.set("birth_date", e.target.value)} />
                </Field>
                <Field label="身份证号" error={form.errors.id_card_no}>
                  <input
                    value={form.values.id_card_no}
                    aria-invalid={!!form.errors.id_card_no}
                    onChange={(e) => form.set("id_card_no", e.target.value)}
                    placeholder="仅管理员可见"
                  />
                </Field>
                <Field label="籍贯">
                  <input value={form.values.native_place} onChange={(e) => form.set("native_place", e.target.value)} />
                </Field>
                <Field label="政治面貌">
                  <input value={form.values.political_status} onChange={(e) => form.set("political_status", e.target.value)} />
                </Field>
                <Field label="婚姻状况">
                  <input value={form.values.marital_status} onChange={(e) => form.set("marital_status", e.target.value)} />
                </Field>
                <Field label="现住址" span>
                  <input value={form.values.address} onChange={(e) => form.set("address", e.target.value)} />
                </Field>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-head">
                <div>
                  <h3>任职与合同</h3>
                  <p>记录用工关系、直属上级和合同有效期。</p>
                </div>
              </div>
              <div className="form-grid">
                <Field label="岗位">
                  <input value={form.values.position} onChange={(e) => form.set("position", e.target.value)} />
                </Field>
                <Field label="直属上级">
                  <select value={form.values.manager_id} onChange={(e) => form.set("manager_id", e.target.value)}>
                    <option value="">未设置</option>
                    {managerChoices.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="用工类型">
                  <select value={form.values.employment_type} onChange={(e) => form.set("employment_type", e.target.value)}>
                    {EMPLOYMENT_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
                <Field label="任职状态">
                  <select value={form.values.employment_status} onChange={(e) => form.set("employment_status", e.target.value)}>
                    {EMPLOYMENT_STATUS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </Field>
                <Field label="入职日期">
                  <input type="date" value={form.values.hire_date} onChange={(e) => form.set("hire_date", e.target.value)} />
                </Field>
                <Field label="转正日期">
                  <input type="date" value={form.values.regular_date} onChange={(e) => form.set("regular_date", e.target.value)} />
                </Field>
                <Field label="离职日期">
                  <input type="date" value={form.values.leave_date} onChange={(e) => form.set("leave_date", e.target.value)} />
                </Field>
                <Field label="工作邮箱" error={form.errors.work_email}>
                  <input
                    value={form.values.work_email}
                    aria-invalid={!!form.errors.work_email}
                    onChange={(e) => form.set("work_email", e.target.value)}
                  />
                </Field>
                <Field label="办公电话">
                  <input value={form.values.office_phone} onChange={(e) => form.set("office_phone", e.target.value)} />
                </Field>
                <Field label="办公地点">
                  <input value={form.values.work_location} onChange={(e) => form.set("work_location", e.target.value)} />
                </Field>
                <Field label="合同类型">
                  <select value={form.values.contract_type} onChange={(e) => form.set("contract_type", e.target.value)}>
                    <option value="">未填写</option>
                    {CONTRACT_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
                <Field label="合同开始">
                  <input type="date" value={form.values.contract_start} onChange={(e) => form.set("contract_start", e.target.value)} />
                </Field>
                <Field label="合同结束">
                  <input type="date" value={form.values.contract_end} onChange={(e) => form.set("contract_end", e.target.value)} />
                </Field>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-head">
                <div>
                  <h3>教育经历</h3>
                  <p>最高学历、院校与专业信息。</p>
                </div>
              </div>
              <div className="form-grid">
                <Field label="最高学历">
                  <input value={form.values.highest_education} onChange={(e) => form.set("highest_education", e.target.value)} />
                </Field>
                <Field label="学位">
                  <input value={form.values.degree} onChange={(e) => form.set("degree", e.target.value)} />
                </Field>
                <Field label="毕业院校">
                  <input value={form.values.school} onChange={(e) => form.set("school", e.target.value)} />
                </Field>
                <Field label="专业">
                  <input value={form.values.major} onChange={(e) => form.set("major", e.target.value)} />
                </Field>
                <Field label="毕业日期">
                  <input type="date" value={form.values.graduation_date} onChange={(e) => form.set("graduation_date", e.target.value)} />
                </Field>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-head">
                <div>
                  <h3>紧急联系人</h3>
                  <p>用于紧急情况下的联系信息。</p>
                </div>
              </div>
              <div className="form-grid">
                <Field label="联系人">
                  <input value={form.values.emergency_contact} onChange={(e) => form.set("emergency_contact", e.target.value)} />
                </Field>
                <Field label="关系">
                  <input value={form.values.emergency_relation} onChange={(e) => form.set("emergency_relation", e.target.value)} />
                </Field>
                <Field label="联系电话">
                  <input value={form.values.emergency_phone} onChange={(e) => form.set("emergency_phone", e.target.value)} />
                </Field>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-head">
                <div>
                  <h3>证件与合同附件</h3>
                  <p>{ATTACHMENT_HINT}。</p>
                </div>
              </div>
              {!contact ? (
                <div className="tiny">先保存人员档案，再上传身份证、学历和合同扫描件。</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value as ContactAttachmentCategory)}
                      style={{ width: 170 }}
                      aria-label="附件分类"
                    >
                      {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                    <label className="btn-primary btn-file" style={{ width: "auto" }}>
                      {uploading ? "上传中…" : "上传附件"}
                      <input
                        type="file"
                        accept={CONTACT_ATTACHMENT_ACCEPT}
                        disabled={uploading}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) upload(file);
                        }}
                      />
                    </label>
                  </div>
                  {attachments.length === 0 ? (
                    <div className="tiny">暂未上传附件</div>
                  ) : (
                    <div className="attachment-list">
                      {attachments.map((item) => (
                        <div className="attachment-row" key={item.id}>
                          <span className="chip">{CATEGORY_LABELS[item.category as ContactAttachmentCategory] || "其他"}</span>
                          <span className="attachment-name" title={item.filename}>{item.filename}</span>
                          <span className="tiny">{formatSize(item.size)}</span>
                          <button
                            type="button"
                            className="linklike"
                            onClick={() => contactsApi.downloadAttachment(contact.id, item.id, item.filename)}
                          >
                            下载
                          </button>
                          <button type="button" className="linklike danger-link" onClick={() => setDeleting(item)}>
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="form-section">
              <div className="form-grid one">
                <Field label="备注">
                  <textarea rows={3} value={form.values.remark} onChange={(e) => form.set("remark", e.target.value)} />
                </Field>
              </div>
            </div>
          </>
        )}
      </Drawer>

      <Confirm
        open={!!deleting}
        title="删除附件"
        text={deleting ? `确定删除「${deleting.filename}」吗？删除后无法恢复。` : ""}
        danger
        okText="删除"
        onConfirm={removeAttachment}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
