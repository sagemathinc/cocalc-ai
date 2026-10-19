/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Revoke content links" (trust-free step 6): every link to this project's
// files on the content origin stops working, e.g. after one was shared by
// mistake.  Open HTML previews in this browser get a new link at once.

import { Button, Popconfirm, message } from "antd";
import { useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { notifyContentLinksRevoked } from "@cocalc/frontend/project/use-project-content-url";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export function RevokeContentLinksButton({ project_id }: { project_id: string }) {
  const [busy, setBusy] = useState(false);

  async function revoke() {
    setBusy(true);
    try {
      const { host_synced } =
        await webapp_client.conat_client.hub.hosts.revokeProjectContentLinks({
          project_id,
        });
      notifyContentLinksRevoked(project_id);
      if (host_synced) {
        message.success("Content links revoked.");
      } else {
        message.warning(
          "Content links revoked. The project's host couldn't be reached; it applies the revocation when it reconnects or sees a new link.",
        );
      }
    } catch (err) {
      message.error(`Couldn't revoke content links: ${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popconfirm
      title="Revoke all content links?"
      description="Every link to this project's files on the content site stops working, for everyone. Open previews elsewhere show an error until they are reopened."
      okText="Revoke"
      okButtonProps={{ danger: true }}
      onConfirm={revoke}
    >
      <Button danger loading={busy} icon={<Icon name="ban" />}>
        Revoke...
      </Button>
    </Popconfirm>
  );
}
