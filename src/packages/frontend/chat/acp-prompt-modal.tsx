/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Button, Modal } from "antd";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-button";
import ChatInput from "./input";

interface Props {
  open: boolean;
  title?: string;
  value: string;
  fontSize?: number;
  onChange?: (value: string) => void;
  onClose: () => void;
  onSave?: (value: string) => void;
}

export function AcpPromptModal({
  open,
  title = "Full agent prompt",
  value,
  fontSize = 13,
  onChange,
  onClose,
  onSave,
}: Props) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (open) {
      setDraft(value);
    }
  }, [open, value]);

  const save = () => {
    onChange?.(draft);
    onSave?.(draft);
    onClose();
  };

  return (
    <Modal
      title={title}
      open={open}
      width={840}
      destroyOnHidden
      onCancel={onClose}
      footer={[
        <Button key="copy" onClick={() => copyTextToClipboard({ text: draft })}>
          Copy
        </Button>,
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button key="save" type="primary" onClick={save}>
          Save
        </Button>,
      ]}
    >
      <ChatInput
        autoFocus
        cacheId="acp-prompt-modal"
        date={0}
        enableMentions={false}
        enableUpload={false}
        fixedMode="editor"
        fontSize={fontSize}
        height="420px"
        input={draft}
        onChange={setDraft}
        on_send={() => undefined}
        syncdb={undefined}
        placeholder="Full prompt sent to the agent..."
      />
    </Modal>
  );
}
