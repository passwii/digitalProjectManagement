"use client";
import { useEffect, useState } from "react";

/** 输入防抖：避免每次按键都打接口（项目选择器 / 筛选条件共用） */
export function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
