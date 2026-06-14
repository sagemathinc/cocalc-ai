/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Input, Modal, Space } from "antd";

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

type AdminRoleAction = "grant" | "revoke";

export function AdminRole({ account_id, name, is_admin }: Props) {
  const [isAdmin, setIsAdmin] = useState<boolean>(!!is_admin);
  const [reason, setReason] = useState<string>("");
  const [running, setRunning] = useState<boolean>(false);
  const [confirmAction, setConfirmAction] = useState<
    AdminRoleAction | undefined
  >(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

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
        setConfirmAction(undefined);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRunning(false);
    }
  }

  async function revokeAdminRole(): Promise<void> {
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
          await webapp_client.conat_client.hub.system.adminRevokeAdminRole({
            browser_id: webapp_client.browser_id,
            user_account_id: account_id,
            reason: trimmedReason,
          });
        setIsAdmin(false);
        setMessage(
          result.was_admin
            ? `${name} is no longer a site admin.`
            : `${name} was not a site admin.`,
        );
        setConfirmAction(undefined);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRunning(false);
    }
  }

  function renderConfirmModal() {
    if (!confirmAction) {
      return;
    }
    const granting = confirmAction === "grant";
    return (
      <Modal
        open
        title={`${granting ? "Grant" : "Remove"} site admin role ${granting ? "to" : "from"} ${name}?`}
        okText={granting ? "Grant admin" : "Remove admin"}
        okButtonProps={{ danger: true, loading: running }}
        cancelButtonProps={{ disabled: running }}
        onOk={() => {
          void (granting ? grantAdminRole() : revokeAdminRole());
        }}
        onCancel={() => setConfirmAction(undefined)}
        maskClosable={!running}
        closable={!running}
      >
        <p>
          {granting
            ? "This gives broad administrative access across CoCalc, including sensitive account, billing, project, and infrastructure controls."
            : "This removes broad administrative access. Self-demotion is blocked unless another active site admin with 2FA remains."}
        </p>
        <p>
          This action requires recent 2FA fresh auth and will be recorded in the
          admin audit log with this reason:
        </p>
        <blockquote style={{ whiteSpace: "pre-wrap" }}>
          {reason.trim()}
        </blockquote>
      </Modal>
    );
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
        <>
          <Alert
            type="info"
            showIcon
            message="This account is a site admin."
            description="Admin access is cluster-wide and includes sensitive account, billing, project, and infrastructure controls."
          />
          <Input.TextArea
            value={reason}
            maxLength={4000}
            showCount
            placeholder="Reason for audit log"
            autoSize={{ minRows: 2, maxRows: 5 }}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            bsStyle="danger"
            disabled={running || !reason.trim()}
            onClick={() => setConfirmAction("revoke")}
          >
            <Icon name={running ? "sync" : "user-times"} spin={running} />{" "}
            Remove site admin role...
          </Button>
        </>
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
          <Button
            bsStyle="danger"
            disabled={running || !reason.trim()}
            onClick={() => setConfirmAction("grant")}
          >
            <Icon name={running ? "sync" : "user-plus"} spin={running} /> Grant
            site admin role...
          </Button>
        </>
      )}
      {renderConfirmModal()}
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
