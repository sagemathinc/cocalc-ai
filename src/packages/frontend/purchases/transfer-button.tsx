import { Button, Modal } from "antd";
import { SwapOutlined } from "@ant-design/icons";
import { useState } from "react";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import CreditTransfers from "./credit-transfers";

export default function TransferButton({
  onApplied,
}: {
  onApplied?: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<SwapOutlined aria-hidden />} onClick={() => setOpen(true)}>
        Transfer
      </Button>
      <Modal
        open={open}
        title="Transfer credit"
        footer={<Button onClick={() => setOpen(false)}>Close</Button>}
        onCancel={() => setOpen(false)}
        destroyOnHidden
        width={640}
        modalRender={(modal) => (
          <KeyboardBoundary boundary="credit-transfer">
            {modal}
          </KeyboardBoundary>
        )}
      >
        {open && <CreditTransfers onApplied={onApplied} />}
      </Modal>
    </>
  );
}
