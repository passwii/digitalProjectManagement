import { notFound } from "next/navigation";
import BillingPage from "@/components/spark/pages/BillingPage";
import ComputePage from "@/components/spark/pages/ComputePage";
import ContentPage from "@/components/spark/pages/ContentPage";
import DashboardPage from "@/components/spark/pages/DashboardPage";
import OpsPage from "@/components/spark/pages/OpsPage";
import PermissionPage from "@/components/spark/pages/PermissionPage";
import SecurityPage from "@/components/spark/pages/SecurityPage";
import StoresPage from "@/components/spark/pages/StoresPage";
import { isSparkSection, type SparkSection } from "@/lib/spark/navigation";

const SECTION_PAGES: Record<SparkSection, () => JSX.Element> = {
  dashboard: DashboardPage,
  stores: StoresPage,
  compute: ComputePage,
  billing: BillingPage,
  content: ContentPage,
  security: SecurityPage,
  ops: OpsPage,
  permission: PermissionPage,
};

export default function SparkSectionPage({ params }: { params: { section: string } }) {
  if (!isSparkSection(params.section)) notFound();
  const Page = SECTION_PAGES[params.section];
  return <Page />;
}
