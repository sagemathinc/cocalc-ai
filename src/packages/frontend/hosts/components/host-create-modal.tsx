import { Modal } from "antd";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import type { HostCreateDraft } from "../create/host-create-draft";
import type { HostCreateViewModel } from "../hooks/use-host-create-view-model";
import { HostCreateCard } from "./host-create-card";

type HostCreateModalProps = {
  open: boolean;
  onClose: () => void;
  vm: HostCreateViewModel;
  initialDraft?: HostCreateDraft | null;
  sourceHost?: Pick<Host, "id" | "name"> | null;
  onInitialDraftConsumed?: () => void;
};

export function HostCreateModal({
  open,
  onClose,
  vm,
  initialDraft,
  sourceHost,
  onInitialDraftConsumed,
}: HostCreateModalProps) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={IS_MOBILE ? "100%" : 1120}
      destroyOnHidden
      styles={{
        body: {
          maxHeight: IS_MOBILE ? "calc(100vh - 32px)" : "calc(100vh - 96px)",
          marginRight: 10,
          overflowY: "auto",
          padding: 12,
        },
      }}
      style={IS_MOBILE ? { top: 8, paddingBottom: 8 } : { top: 32 }}
    >
      <HostCreateCard
        vm={vm}
        initialDraft={initialDraft}
        sourceHost={sourceHost}
        onInitialDraftConsumed={onInitialDraftConsumed}
      />
    </Modal>
  );
}
