/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Popconfirm, Space } from "antd";

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
  const [disablingTwoFactor, setDisablingTwoFactor] = useState(false);
  const [link, setLink] = useState<string | undefined>(undefined);
  const [verifyMessage, setVerifyMessage] = useState<string | undefined>(
    undefined,
  );
  const [twoFactorMessage, setTwoFactorMessage] = useState<string | undefined>(
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
        if (!/^https?:\/\//i.test(nextLink)) {
          nextLink = `${document.location.origin}${
            appBasePath.length <= 1 ? "" : appBasePath
          }${nextLink}`;
        }
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

  async function disableTwoFactor(): Promise<void> {
    setDisablingTwoFactor(true);
    setError(undefined);
    setTwoFactorMessage(undefined);
    try {
      await runFreshAuthAction(async () => {
        const result =
          await webapp_client.conat_client.hub.system.adminDisableTwoFactor({
            browser_id: webapp_client.browser_id,
            user_account_id: account_id,
          });
        setTwoFactorMessage(
          result.disabled_factors > 0
            ? `Removed ${result.disabled_factors} 2FA method${
                result.disabled_factors === 1 ? "" : "s"
              } from this account.`
            : "This account did not have active 2FA methods.",
        );
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setDisablingTwoFactor(false);
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

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {renderError()}
      {verifyMessage ? (
        <Alert type="success" showIcon message={verifyMessage} />
      ) : undefined}
      {twoFactorMessage ? (
        <Alert type="success" showIcon message={twoFactorMessage} />
      ) : undefined}
      <div>
        <b>Password Reset:</b>
        {email_address ? (
          <>
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
          </>
        ) : (
          <div style={{ marginTop: "10px" }}>
            User does not have an email address set, so password reset does not
            make sense.
          </div>
        )}
      </div>
      <div>
        <b>Email Verification:</b>
        {email_address ? (
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
        ) : (
          <div style={{ marginTop: "10px" }}>
            User does not have an email address set, so email verification does
            not make sense.
          </div>
        )}
      </div>
      <div>
        <b>Two-Factor Authentication Recovery:</b>
        <div style={{ marginTop: "10px" }}>
          <Popconfirm
            title="Remove all 2FA methods for this account?"
            description="Only do this after independently verifying the user's identity."
            okText="Remove 2FA"
            okButtonProps={{ danger: true }}
            disabled={disablingTwoFactor}
            onConfirm={() => {
              void disableTwoFactor();
            }}
          >
            <Button bsStyle="danger" disabled={disablingTwoFactor}>
              <Icon
                name={disablingTwoFactor ? "sync" : "lock-open"}
                spin={disablingTwoFactor}
              />{" "}
              Remove 2FA from account...
            </Button>
          </Popconfirm>
        </div>
      </div>
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
