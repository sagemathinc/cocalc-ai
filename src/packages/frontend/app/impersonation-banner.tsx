/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space } from "antd";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";

export function ImpersonationBanner() {
  const impersonation = useTypedRedux("account", "impersonation");
  const first_name = useTypedRedux("account", "first_name");
  const last_name = useTypedRedux("account", "last_name");
  const email_address = useTypedRedux("account", "email_address");
  const actions = useActions("account");

  if (!impersonation?.active) {
    return null;
  }

  const subject =
    `${first_name ?? ""} ${last_name ?? ""}`.trim() ||
    `${email_address ?? ""}`.trim() ||
    impersonation.subject_account_id;
  const actor =
    `${impersonation.actor_name ?? ""}`.trim() ||
    `${impersonation.actor_email_address ?? ""}`.trim() ||
    impersonation.actor_account_id;

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: "10px" }}
      message={`Impersonating ${subject}`}
      description={
        <Space direction="vertical" size="small">
          <div>Admin actor: {actor}</div>
          <div>
            Sensitive operational actions use the admin actor's recent 2FA, not
            the subject user's.
          </div>
          <div>
            <Button
              size="small"
              onClick={() => void actions.sign_out(false, true)}
            >
              End impersonation
            </Button>
          </div>
        </Space>
      }
    />
  );
}
