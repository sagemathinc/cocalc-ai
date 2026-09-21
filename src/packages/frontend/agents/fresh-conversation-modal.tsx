import { useState } from "react";
import { Alert, Modal } from "antd";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export function FreshConversationModal({
  name,
  onConfirm,
  onClose,
}: {
  name: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={`Start a fresh conversation with @${name}?`}
      modalRender={(modal) => <KeyboardBoundary>{modal}</KeyboardBoundary>}
      okText="Start fresh conversation"
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      onOk={() => void confirm()}
      onCancel={() => !busy && onClose()}
    >
      <p>
        Keep this agent's name, networks, appearance, settings, and files. The
        previous conversation is preserved, but its messages will not be
        included in the new context.
      </p>
      <p>
        Finish or cancel running and queued work first. Disable scheduled work
        before continuing.
      </p>
      {error && (
        <Alert
          role="alert"
          type="error"
          showIcon
          title={error}
          description="If preparation was interrupted, retry here to finish the same switch. No conversation is deleted."
        />
      )}
    </Modal>
  );
}
