/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Space } from "antd";

import { useState } from "@cocalc/frontend/app-framework";
import { Button } from "@cocalc/frontend/antd-bootstrap";
import {
  CopyToClipBoard,
  Icon,
  ErrorDisplay,
} from "@cocalc/frontend/components";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { webapp_client } from "../../webapp-client";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

interface Props {
  account_id: string;
  email_address: string;
}

export function PasswordReset({ account_id, email_address }: Props) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [link, setLink] = useState<string | undefined>(undefined);
  const [verifyMessage, setVerifyMessage] = useState<string | undefined>(
    undefined,
  );
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => {
      setError(`${err}`);
    },
  });

  async function requestPasswordReset(): Promise<void> {
    setRunning(true);
    setError(undefined);
    try {
      await runFreshAuthAction(async () => {
        let nextLink =
          await webapp_client.conat_client.hub.system.adminResetPasswordLink({
            browser_id: webapp_client.browser_id,
            user_account_id: account_id,
          });
        nextLink = `${document.location.origin}${
          appBasePath.length <= 1 ? "" : appBasePath
        }${nextLink}`;
        setLink(nextLink);
      });
    } catch (err) {
      setError(`${err}`);
      setLink(undefined);
    } finally {
      setRunning(false);
    }
  }

  async function verifyEmailAddress(): Promise<void> {
    setVerifying(true);
    setError(undefined);
    setVerifyMessage(undefined);
    try {
      await runFreshAuthAction(async () => {
        const result =
          await webapp_client.conat_client.hub.system.adminVerifyEmailAddress({
            browser_id: webapp_client.browser_id,
            user_account_id: account_id,
          });
        setVerifyMessage(
          result.already_verified
            ? `${result.email_address} was already verified.`
            : `${result.email_address} is now verified.`,
        );
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setVerifying(false);
    }
  }

  function renderError() {
    if (!error) {
      return;
    }
    return (
      <ErrorDisplay
        style={{ margin: "15px 0" }}
        error={error}
        onClose={() => {
          setError(undefined);
        }}
      />
    );
  }

  function renderPasswordResetLink() {
    if (!link) return;
    return (
      <div style={{ marginTop: "15px" }}>
        Send this somehow to{" "}
        <a
          href={`mailto:${email_address}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {email_address}
        </a>
        .
        <div style={{ marginTop: "10px" }}>
          <CopyToClipBoard value={link} />
        </div>
      </div>
    );
  }

  if (!email_address) {
    return (
      <div>
        User does not have an email address set, so password reset and email
        verification do not make sense.
      </div>
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {renderError()}
      {verifyMessage ? (
        <Alert type="success" showIcon message={verifyMessage} />
      ) : undefined}
      <div>
        <b>Password Reset:</b>
        <div style={{ marginTop: "10px" }}>
          <Button
            disabled={running}
            onClick={() => {
              void requestPasswordReset();
            }}
          >
            <Icon name={running ? "sync" : "lock-open"} spin={running} />{" "}
            Request Password Reset Link...
          </Button>
        </div>
        {renderPasswordResetLink()}
      </div>
      <div>
        <b>Email Verification:</b>
        <div style={{ marginTop: "10px" }}>
          <Button
            disabled={verifying}
            onClick={() => {
              void verifyEmailAddress();
            }}
          >
            <Icon name={verifying ? "sync" : "check"} spin={verifying} />{" "}
            Admin-verify email address
          </Button>
        </div>
      </div>
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
