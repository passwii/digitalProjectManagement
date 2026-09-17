export const MIN_ACTIVITY_MS = 450;

export type ActivityScope = "navigation" | "content" | "form";

export interface ActivityInput {
  label: string;
  scope: ActivityScope;
}

export interface ActivityRecord extends ActivityInput {
  id: number;
  startedAt: number;
}

export function completionDelay(
  activity: Pick<ActivityRecord, "startedAt">,
  finishedAt: number,
  minimum = MIN_ACTIVITY_MS,
): number {
  return Math.max(0, activity.startedAt + minimum - finishedAt);
}

export function activityLabel(records: ActivityRecord[]): string {
  if (records.length === 0) return "";
  if (records.length === 1) return records[0].label;
  return `${records[0].label}等 ${records.length} 项`;
}

export function routeActivityKey(pathname: string, search: string): string {
  return search ? `${pathname}?${search}` : pathname;
}
