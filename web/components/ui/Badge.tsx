import st from "./Badge.module.css";

export type BadgeTone = "todo" | "doing" | "paused" | "warn" | "danger" | "done";

function toneFor(status: string): BadgeTone {
  const s = (status ?? "").trim();
  if (/完成|已通过|通过|已支出|已付款|已归档|特批/.test(s)) return "done";
  if (/逾期|超支|驳回|已取消|失败/.test(s)) return "danger";
  if (/预警|待审|待付|80|临近/.test(s)) return "warn";
  if (/暂停|草稿|未开始/.test(s)) return "paused";
  if (/进行|立项|跟进|执行|审批中|待办/.test(s)) return "doing";
  return "todo";
}

export default function Badge({
  status,
  tone,
}: {
  status: string;
  tone?: BadgeTone;
}) {
  const t = tone ?? toneFor(status);
  return (
    <span className={`${st.badge} ${st[t]}`} title={status}>
      {status}
    </span>
  );
}
