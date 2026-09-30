"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/Modal";
import ChangePasswordForm from "@/components/auth/ChangePasswordForm";

export default function ChangePasswordDialog() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) router.back();
  };

  return (
    <Dialog
      open
      title="修改密码"
      size="sm"
      onClose={close}
      maskClosable={!busy}
    >
      <ChangePasswordForm
        required={false}
        onClose={close}
        onSuccess={() => router.back()}
        onBusyChange={setBusy}
      />
    </Dialog>
  );
}
