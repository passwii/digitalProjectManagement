"use client";

import SheetCard from "../SheetCard";
import type { SheetContentProps } from "./index";

export default function AssetsSheet({ onSelect }: SheetContentProps) {
  return (
    <SheetCard
      href="/assets"
      title="资产管理"
      note="资产台账与生命周期"
      onSelect={onSelect}
    />
  );
}
