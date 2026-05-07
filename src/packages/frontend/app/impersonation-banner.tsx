/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button } from "antd";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";

export function ImpersonationBanner() {
  const rawImpersonation = useTypedRedux("account", "impersonation") as any;
  const impersonation =
    rawImpersonation?.toJS?.() ?? rawImpersonation ?? undefined;
  const first_name = useTypedRedux("account", "first_name");
  const last_name = useTypedRedux("account", "last_name");
  const email_address = useTypedRedux("account", "email_address");
  const actions = useActions("account");

  if (impersonation?.active !== true) {
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
      banner
      style={{ marginBottom: "10px", paddingBlock: "6px" }}
      message={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            flexWrap: "wrap",
            width: "100%",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <strong>Impersonating {subject}</strong>
            <span style={{ marginLeft: "10px" }}>
              Admin actor: {actor}. Operational actions use the admin actor's
              recent 2FA.
            </span>
          </div>
          <Button
            size="small"
            onClick={() => void actions.sign_out(false, true)}
          >
            End impersonation
          </Button>
        </div>
      }
    />
  );
}
