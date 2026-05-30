/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Input, Popconfirm, Space } from "antd";

import { Button } from "@cocalc/frontend/antd-bootstrap";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { ErrorDisplay, Icon } from "@cocalc/frontend/components";
import { useState } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

interface Props {
  account_id: string;
  name: string;
  is_admin?: boolean;
}

export function AdminRole({ account_id, name, is_admin }: Props) {
  const [isAdmin, setIsAdmin] = useState<boolean>(!!is_admin);
  const [reason, setReason] = useState<string>("");
  const [running, setRunning] = useState<boolean>(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => {
      setError(`${err}`);
    },
  });

  async function grantAdminRole(): Promise<void> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("A reason is required for the audit log.");
      return;
    }
    setRunning(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await runFreshAuthAction(async () => {
        const result =
          await webapp_client.conat_client.hub.system.adminGrantAdminRole({
            browser_id: webapp_client.browser_id,
            user_account_id: account_id,
            reason: trimmedReason,
          });
        setIsAdmin(true);
        setMessage(
          result.already_admin
            ? `${name} was already a site admin.`
            : `${name} is now a site admin.`,
        );
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <div>
        <b>Site Admin Role:</b>
      </div>
      {error ? (
        <ErrorDisplay
          error={error}
          onClose={() => setError(undefined)}
          style={{ margin: "0" }}
        />
      ) : undefined}
      {message ? (
        <Alert type="success" showIcon message={message} />
      ) : undefined}
      {isAdmin ? (
        <Alert
          type="info"
          showIcon
          message="This account is a site admin."
          description="Admin access is cluster-wide and includes sensitive account, billing, project, and infrastructure controls."
        />
      ) : (
        <>
          <Alert
            type="warning"
            showIcon
            message="Grant site admin role"
            description="This is a high-risk, audited action. It requires recent 2FA fresh auth and adds the admin group without removing any existing groups."
          />
          <Input.TextArea
            value={reason}
            maxLength={4000}
            showCount
            placeholder="Reason for audit log"
            autoSize={{ minRows: 2, maxRows: 5 }}
            onChange={(e) => setReason(e.target.value)}
          />
          <Popconfirm
            title={`Grant site admin role to ${name}?`}
            description="This gives broad administrative access across CoCalc."
            okText="Grant admin"
            okButtonProps={{ danger: true }}
            disabled={running || !reason.trim()}
            onConfirm={() => {
              void grantAdminRole();
            }}
          >
            <Button bsStyle="danger" disabled={running || !reason.trim()}>
              <Icon name={running ? "sync" : "user-plus"} spin={running} />{" "}
              Grant site admin role...
            </Button>
          </Popconfirm>
        </>
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
