/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { Alert, Button, Card, Modal, Space } from "antd";
import { FormattedMessage, useIntl } from "react-intl";

import { emailVerificationMsg } from "@cocalc/frontend/account/settings/email-verification";
import {
  CSS,
  useActions,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { getNow } from "@cocalc/frontend/app/util";
import { Icon, Paragraph, Text, Title } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useAccountStoreReady } from "./account-store-ready";

const DISMISSED_KEY_LS = "verify-email-dismissed";

export function VerifyEmail() {
  const [hide, setHide] = useState<boolean>(false);
  const show = useShowVerifyEmail();

  function doDismiss(save = true) {
    if (save) {
      const now = getNow();
      LS.set(DISMISSED_KEY_LS, now);
    }
    setHide(true);
  }

  if (show && !hide) {
    return <VerifyEmailModal doDismiss={doDismiss} />;
  } else {
    return null;
  }
}

function VerifyEmailModal({
  doDismiss,
}: {
  doDismiss: (save?: boolean) => void;
}) {
  const intl = useIntl();
  const page_actions = useActions("page");
  const email_address = useTypedRedux("account", "email_address");

  const [error, setError] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [sent, setSent] = useState<boolean>(false);

  async function verify(): Promise<void> {
    setError("");
    setSending(true);
    try {
      await webapp_client.account_client.send_verification_email();
      setSent(true);
    } catch (err) {
      const errMsg = `Problem sending email verification: ${err}`;
      setError(errMsg);
      setSent(false);
    } finally {
      setSending(false);
    }
  }

  // TODO: at one point this should be a popup to just edit the email address
  function edit() {
    doDismiss(false);
    page_actions.set_active_tab("account");
  }

  function renderBanner() {
    if (error) {
      return <Text type="danger">{error}</Text>;
    }
    return (
      <>
        <Paragraph strong>
          <FormattedMessage
            id="app.verify-email-banner.text"
            defaultMessage={`{sent, select,
            true {Email Sent! Please check your email inbox (and maybe spam) and click on the confirmation link.}
            other {Please check and verify your email address:}}`}
            values={{
              sent,
              code: (c) => <Text code>{c}</Text>,
            }}
          />
        </Paragraph>
        {!sent ? (
          <>
            <Paragraph code style={{ textAlign: "center" }}>
              {email_address}
            </Paragraph>
            <Paragraph type="secondary">
              <FormattedMessage
                id="app.verify-email-banner.help.text"
                defaultMessage="It's important to have a working email address. We use it for password resets, sending messages, billing notifications, and support. Please ensure your email is correct to stay informed."
              />
            </Paragraph>
            <Paragraph type="secondary">
              <FormattedMessage
                id="app.verify-email-banner.edit.prefix"
                defaultMessage="If the email address is wrong,"
              />{" "}
              <Button size="small" type="link" onClick={edit}>
                <Icon name="pencil" />{" "}
                <FormattedMessage
                  id="app.verify-email-banner.edit.button"
                  defaultMessage="edit it in account settings"
                />
              </Button>
              .
            </Paragraph>
          </>
        ) : null}
      </>
    );
  }

  function renderFooter() {
    if (sent) {
      return (
        <Button onClick={() => doDismiss()} type="primary">
          {intl.formatMessage(labels.close)}
        </Button>
      );
    }

    return (
      <Space>
        <Button onClick={() => doDismiss()}>
          {intl.formatMessage(labels.close)}
        </Button>
        <Button
          onClick={verify}
          type="primary"
          loading={sending}
          disabled={sent || sending}
        >
          {intl.formatMessage(emailVerificationMsg, {
            state: sending ? "sending" : sent ? "sent" : "idle",
          })}
        </Button>
      </Space>
    );
  }

  function renderTitle() {
    return (
      <>
        <Icon name="mail" />{" "}
        {intl.formatMessage({
          id: "app.verify-email-banner.title",
          defaultMessage: "Verify Your Email Address",
        })}
      </>
    );
  }

  return (
    <Modal
      title={renderTitle()}
      open={true}
      onCancel={() => doDismiss()}
      footer={renderFooter()}
    >
      {renderBanner()}
    </Modal>
  );
}

export function useShowVerifyEmail(): boolean {
  const email_address = useTypedRedux("account", "email_address");
  const email_address_verified = useTypedRedux(
    "account",
    "email_address_verified",
  );
  const loaded = useAccountStoreReady();

  const emailSendingEnabled = useTypedRedux("customize", "email_enabled");

  const created = useTypedRedux("account", "created");

  const dismissedTS = LS.get<number>(DISMISSED_KEY_LS);

  const show_verify_email =
    !email_address || !email_address_verified?.get(email_address);

  // we also do not show this for newly created accounts
  const now = getNow();
  const oneDay = 1 * 24 * 60 * 60 * 1000;
  const notTooNew = created != null && now > created.getTime() + oneDay;

  // dismissed banner works for a week
  const dismissed =
    typeof dismissedTS === "number" && now < dismissedTS + 7 * oneDay;

  return (
    show_verify_email &&
    loaded &&
    notTooNew &&
    !dismissed &&
    emailSendingEnabled
  );
}

export function useEmailVerificationRequired(): boolean {
  const loaded = useAccountStoreReady();
  const verifyEmails = !!useTypedRedux("customize", "verify_emails");
  const email_address = useTypedRedux("account", "email_address");
  const email_address_verified = useTypedRedux(
    "account",
    "email_address_verified",
  );

  return (
    loaded &&
    verifyEmails &&
    (!email_address || !email_address_verified?.get(email_address))
  );
}

export function VerifyEmailRequiredPanel({
  title,
  description,
  style,
  compact,
}: {
  title?: ReactNode;
  description?: ReactNode;
  style?: CSS;
  compact?: boolean;
}) {
  const intl = useIntl();
  const page_actions = useActions("page");
  const email_address = useTypedRedux("account", "email_address");
  const emailSendingEnabled = !!useTypedRedux("customize", "email_enabled");
  const [error, setError] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [sent, setSent] = useState<boolean>(false);

  async function verify(): Promise<void> {
    setError("");
    setSending(true);
    try {
      await webapp_client.account_client.send_verification_email();
      setSent(true);
    } catch (err) {
      setError(`Problem sending email verification: ${err}`);
      setSent(false);
    } finally {
      setSending(false);
    }
  }

  function openSettings() {
    page_actions.set_active_tab("account");
  }

  return (
    <Card
      style={{
        maxWidth: compact ? 620 : 760,
        margin: compact ? "12px auto" : "64px auto",
        textAlign: "center",
        ...style,
      }}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Title level={compact ? 4 : 2} style={{ marginBottom: 0 }}>
          <Icon name="mail" />{" "}
          {title ??
            intl.formatMessage({
              id: "app.verify-email-required.title",
              defaultMessage: "Verify your email address",
            })}
        </Title>
        <Paragraph style={{ fontSize: compact ? undefined : "12pt" }}>
          {description ??
            intl.formatMessage({
              id: "app.verify-email-required.description",
              defaultMessage:
                "This site requires a verified email address before you can continue.",
            })}
        </Paragraph>
        {email_address ? (
          <Paragraph code style={{ textAlign: "center" }}>
            {email_address}
          </Paragraph>
        ) : (
          <Alert
            showIcon
            type="warning"
            message="No email address is set for this account."
          />
        )}
        {sent ? (
          <Alert
            showIcon
            type="success"
            message={`Verification email sent${email_address ? ` to ${email_address}` : ""}.`}
            description="Check your inbox and spam folder, then click the verification link."
          />
        ) : null}
        {error ? <Alert showIcon type="error" message={error} /> : null}
        {!emailSendingEnabled && email_address ? (
          <Alert
            showIcon
            type="warning"
            message="Email delivery is not configured on this site."
            description="Open account settings to review your email address, or contact the site administrator to verify it."
          />
        ) : null}
        <Space wrap style={{ justifyContent: "center" }}>
          {email_address && emailSendingEnabled ? (
            <Button
              type="primary"
              size={compact ? "middle" : "large"}
              loading={sending}
              disabled={sent || sending}
              onClick={verify}
            >
              {intl.formatMessage(emailVerificationMsg, {
                state: sending ? "sending" : sent ? "sent" : "idle",
              })}
            </Button>
          ) : null}
          <Button size={compact ? "middle" : "large"} onClick={openSettings}>
            <Icon name="pencil" /> Open account settings
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
