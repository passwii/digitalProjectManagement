import st from "./Avatar.module.css";

const TONES = [st.a0, st.a1, st.a2, st.a3, st.a4, st.a5];

export default function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const ch = (name ?? "").trim().slice(0, 1) || "人";
  let h = 0;
  for (const c of name ?? "") h = (h * 31 + c.charCodeAt(0)) % 997;
  return (
    <span className={`${st.avatar} ${TONES[h % TONES.length]}`} title={name} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>
      {ch}
    </span>
  );
}
