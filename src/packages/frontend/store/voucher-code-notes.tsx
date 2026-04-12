/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";

import { Alert, Button, Input, Space } from "antd";

import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { Icon, Tooltip } from "@cocalc/frontend/components";

import { setVoucherCodeNotes } from "./api";

export default function VoucherCodeNotes({
  code,
  notes: notes0,
}: {
  code: string;
  notes?: string;
}) {
  const [editing, setEditing] = useState<boolean>(false);
  const [notes, setNotes] = useState<string>(notes0 ?? "");
  const [editValue, setEditValue] = useState<string>(notes0 ?? "");
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);

  if (editing) {
    return (
      <div style={{ width: "320px" }}>
        <Input.TextArea
          autoSize={{ minRows: 3, maxRows: 8 }}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
        />
        <Space style={{ marginTop: "8px" }}>
          <Button
            loading={saving}
            type="primary"
            onClick={async () => {
              try {
                setSaving(true);
                setError("");
                await setVoucherCodeNotes(code, editValue);
                setNotes(editValue);
                setEditing(false);
              } catch (err) {
                setError(`${err}`);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save
          </Button>
          <Button
            onClick={() => {
              setEditValue(notes);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </Space>
        {error && (
          <Alert
            style={{ marginTop: "8px" }}
            title={error}
            showIcon
            type="error"
          />
        )}
      </div>
    );
  }

  if (notes) {
    return (
      <Tooltip title="Click to edit your private note">
        <div onClick={() => setEditing(true)} style={{ cursor: "pointer" }}>
          <StaticMarkdown value={notes} />
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip title="Add a private note about this voucher code">
      <Button type="text" onClick={() => setEditing(true)}>
        <Icon name="plus" />
      </Button>
    </Tooltip>
  );
}
