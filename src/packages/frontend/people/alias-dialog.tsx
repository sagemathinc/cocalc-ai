/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Alert, Form, Input, Modal } from "antd";

// Edit a private @alias. Saving an empty value clears it.
export function AliasDialog({
  open,
  title,
  alias,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  alias?: string | null;
  onSave: (alias: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(alias ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(alias ?? "");
      setError("");
    }
  }, [open, alias]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave(value);
      onClose();
    } catch (err) {
      setError(`${err}`.replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      title={`Personal alias for ${title}`}
      okText="Save"
      confirmLoading={busy}
      onOk={save}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form layout="vertical" onFinish={save}>
        <Form.Item
          label="Alias"
          htmlFor="people-alias-input"
          extra="Only you see this alias. Use it to find this quickly, e.g. @team. Leave empty to remove."
        >
          <Input
            id="people-alias-input"
            prefix="@"
            autoFocus
            maxLength={64}
            value={value.replace(/^@/, "")}
            onChange={(e) => setValue(e.target.value)}
          />
        </Form.Item>
        {error && <Alert role="alert" type="error" title={error} />}
      </Form>
    </Modal>
  );
}
