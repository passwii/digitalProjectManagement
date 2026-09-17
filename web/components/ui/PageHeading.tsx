import st from "./PageHeading.module.css";
import MotionReveal from "@/components/motion/MotionReveal";

export default function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <MotionReveal className={st.head}>
      <div className={st.copy}>
        <h1 className={st.title}>{title}</h1>
        {description && <p className={st.description}>{description}</p>}
      </div>
      {actions && <div className={`${st.actions} no-print`}>{actions}</div>}
    </MotionReveal>
  );
}
