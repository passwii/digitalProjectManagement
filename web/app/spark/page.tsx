import { redirect } from "next/navigation";

export default function SparkIndexPage(): never {
  redirect("/spark/dashboard");
}
