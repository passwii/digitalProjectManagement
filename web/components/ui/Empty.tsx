import st from "./Empty.module.css";

export default function Empty({ title = "暂无数据", hint }: { title?: string; hint?: string }) {
  return (
    <div className={st.empty}>
      <div className={st.art} aria-hidden="true">
        <span className={st.c1} />
        <span className={st.c2} />
        <span className={st.c3} />
      </div>
      <div className={st.title}>{title}</div>
      {hint && <div className={st.hint}>{hint}</div>}
    </div>
  );
}
