import { Modal, Popover } from "antd";
import { useState } from "react";

// Keep the composer and editor real, but avoid live services in the harness.
export const ThreadBadge = () => null;
export const CodexGoalControl = () => null;
export const AcpPromptModal = () => null;
export const DictateButton = () => null;
export const AgentFileAttachment = () => null;
export const NameAgent = () => null;
export const getCodexPaymentSourceOptions = () => [];
export const isCodexPaymentSourceNeedsUserConfiguration = () => false;
export const useAgentMentions = () => ({
  agents: [],
  context: { onSelect: () => {} },
  preflight: (_value: string, send: () => void) => send(),
});

export function CodexConfigButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Popover
        trigger="click"
        content={<button onClick={() => setOpen(true)}>Choose model</button>}
      >
        <button>Model settings</button>
      </Popover>
      <Modal
        title="Model options"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
      >
        <button onClick={() => setOpen(false)}>Keep current model</button>
      </Modal>
    </>
  );
}
