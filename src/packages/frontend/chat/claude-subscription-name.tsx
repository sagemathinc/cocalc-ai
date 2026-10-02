/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Input, Space, Typography } from "antd";
import { useRef, useState } from "react";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { Icon } from "@cocalc/frontend/components/icon";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { webapp_client } from "@cocalc/frontend/webapp-client";

/**
 * Below the credential picker (which shows the name): rename the selected
 * subscription in place, and when its long-lived token expires.
 */
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
  const expiresAt = credential.metadata?.expires_at;

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
    <div>
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
        <Space size={8} wrap>
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
            {current ? "Rename" : "Name this subscription"}
          </Button>
          {typeof expiresAt === "string" && (
            <Typography.Text type="secondary">
              Long-lived token, expires <TimeAgo date={expiresAt} />
            </Typography.Text>
          )}
        </Space>
      )}
      {error && (
        <div role="alert">
          <Typography.Text type="danger">{error}</Typography.Text>
        </div>
      )}
    </div>
  );
}
