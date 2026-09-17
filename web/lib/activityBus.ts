import type { ActivityInput } from "./activityCore";

type ActivityHandler = (input: ActivityInput) => () => void;

let handler: ActivityHandler | null = null;

export function setActivityHandler(next: ActivityHandler | null) {
  handler = next;
}

/** 让非 React 的 API 封装也能接入全局活动条；无 Provider 时安全降级。 */
export function beginTrackedActivity(input: ActivityInput): () => void {
  return handler ? handler(input) : () => {};
}
