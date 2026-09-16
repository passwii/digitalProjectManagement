"use client";
// 极简表单状态：值/错误/脏标记/校验。零依赖，配合 components/ui/Field 使用。
import { useCallback, useMemo, useRef, useState } from "react";

export interface Rule<T> {
  /** 必填（可传自定义提示文案） */
  required?: boolean | string;
  /** 最小长度（字符串）或最小值（数字），按类型自动判断 */
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** 自定义校验：返回错误文案，通过返回 null */
  custom?: (value: unknown, all: T) => string | null;
  label?: string;
}

export type Rules<T> = Partial<Record<keyof T, Rule<T>>>;
export type Errors<T> = Partial<Record<keyof T, string>>;

export function useForm<T extends object>(initial: T, rules?: Rules<T>) {
  const initialRef = useRef(initial);
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Errors<T>>({});
  const [dirty, setDirty] = useState(false);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }, []);

  const patch = useCallback((partial: Partial<T>) => {
    setValues((prev) => ({ ...prev, ...partial }));
    setDirty(true);
  }, []);

  const reset = useCallback((next?: T) => {
    setValues(next ?? initialRef.current);
    setErrors({});
    setDirty(false);
  }, []);

  const validate = useCallback((): boolean => {
    const found: Errors<T> = {};
    for (const key of Object.keys(values) as (keyof T)[]) {
      const rule = rules?.[key];
      if (!rule) continue;
      const v = values[key];
      const label = rule.label ?? String(key);
      const empty = v === "" || v === null || v === undefined;
      if (rule.required && empty) {
        found[key] = typeof rule.required === "string" ? rule.required : `${label}不能为空`;
        continue;
      }
      if (empty) continue;
      if (typeof v === "number") {
        if (rule.min !== undefined && v < rule.min) found[key] = `${label}不能小于 ${rule.min}`;
        if (rule.max !== undefined && v > rule.max) found[key] = `${label}不能大于 ${rule.max}`;
      } else if (typeof v === "string") {
        if (rule.min !== undefined && v.length < rule.min) found[key] = `${label}至少 ${rule.min} 个字符`;
        if (rule.max !== undefined && v.length > rule.max) found[key] = `${label}最多 ${rule.max} 个字符`;
        if (rule.pattern && !rule.pattern.test(v)) found[key] = `${label}格式不正确`;
      }
      if (rule.custom) {
        const msg = rule.custom(v, values);
        if (msg) found[key] = msg;
      }
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  }, [rules, values]);

  return useMemo(
    () => ({ values, set, patch, reset, errors, setErrors, dirty, validate, setDirty }),
    [values, set, patch, reset, errors, dirty, validate]
  );
}
