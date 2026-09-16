"use client";
// 项目范围探测：只取 1 条（total 足够判断“是否有可参与项目”），
// 替代 Stage 2 里为了判断存在性而拉取 100 条项目的做法（BLF-1095）。
import { projectsApi, type Project } from "./api";
import { useAsyncData } from "./useAsyncData";

export function useProjectsProbe() {
  const { data, loading, error, reload } = useAsyncData(
    (signal) => projectsApi.list("?page=1&size=1", signal),
    [],
  );
  return {
    hasProjects: (data?.total ?? 0) > 0,
    probing: loading && data === null,
    probeError: data === null ? error : "",
    reloadProbe: reload,
  };
}
