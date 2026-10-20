import { redirect } from "next/navigation";
import { AV_HOME } from "@/lib/av/navigation";

/** `/stream-monitor` 由 middleware 做 HTTP 301 到 `/stream-monitor/overview`；这里是客户端兜底（直接 RSC 请求也不会白屏）。 */
export default function AvIndexPage(): never {
  redirect(AV_HOME);
}
