/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Input, Typography } from "antd";
import { useRef, useState } from "react";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { Icon } from "@cocalc/frontend/components/icon";
import { webapp_client } from "@cocalc/frontend/webapp-client";

/** Rename the selected subscription in place (the picker shows its name). */
export function ClaudeSubscriptionName({
  credential,
  onRenamed,
}: {
  credential: ExternalCredentialInfo;
  onRenamed: (label: string | undefined) => void;
}) {
  const current = `${credential.metadata?.label ?? ""}`.trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const done = useRef(false);

  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const label = draft.trim().slice(0, 60);
    if (!save || label === current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { updated } =
        await webapp_client.conat_client.hub.system.updateClaudeSubscriptionLabel(
          { id: credential.id, label: label || undefined },
        );
      if (!updated) throw Error("This subscription is no longer connected.");
      onRenamed(label || undefined);
      setEditing(false);
    } catch (err) {
      setError(`${err}`.replace(/^Error: /, ""));
      done.current = false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {editing ? (
        <Input
          size="small"
          autoFocus
          aria-label="Subscription name"
          placeholder="e.g. Max 20x"
          maxLength={60}
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={() => void finish(true)}
          onBlur={() => void finish(true)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // Cancel the rename without closing the surrounding dialog.
            event.stopPropagation();
            void finish(false);
          }}
          style={{ width: 220 }}
        />
      ) : (
        <Button
          type="link"
          size="small"
          icon={<Icon name="pencil" />}
          style={{ padding: 0 }}
          onClick={() => {
            done.current = false;
            setDraft(current);
            setEditing(true);
          }}
        >
          {current ? "Rename" : "Name"}
        </Button>
      )}
      {error && (
        <Typography.Text type="danger" role="alert">
          {error}
        </Typography.Text>
      )}
    </>
  );
}
