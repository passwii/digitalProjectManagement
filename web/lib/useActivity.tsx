"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  activityLabel,
  completionDelay,
  type ActivityInput,
  type ActivityRecord,
} from "./activityCore";

interface ActivityContextValue {
  beginActivity: (input: ActivityInput) => () => void;
  active: boolean;
  label: string;
}

const ActivityContext = createContext<ActivityContextValue | null>(null);

export function ActivityProvider({ children }: { children: React.ReactNode }) {
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());
  const [records, setRecords] = useState<ActivityRecord[]>([]);

  const finishRecord = useCallback((id: number) => {
    setRecords((current) => current.filter((item) => item.id !== id));
  }, []);

  const beginActivity = useCallback((input: ActivityInput) => {
    const record: ActivityRecord = {
      ...input,
      id: ++seq.current,
      startedAt: Date.now(),
    };
    setRecords((current) => [...current, record]);

    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const delay = completionDelay(record, Date.now());
      const timer = window.setTimeout(() => {
        timers.current.delete(record.id);
        finishRecord(record.id);
      }, delay);
      timers.current.set(record.id, timer);
    };
  }, [finishRecord]);

  const value = useMemo<ActivityContextValue>(
    () => ({
      beginActivity,
      active: records.length > 0,
      label: activityLabel(records),
    }),
    [beginActivity, records],
  );

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

const fallback: ActivityContextValue = {
  beginActivity: () => () => {},
  active: false,
  label: "",
};

export function useActivity(): ActivityContextValue {
  return useContext(ActivityContext) ?? fallback;
}
