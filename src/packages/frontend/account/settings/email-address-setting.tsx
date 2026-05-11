/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Input, Space } from "antd";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { ErrorDisplay, LabeledRow, Saving } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";
import { MIN_PASSWORD_LENGTH } from "@cocalc/util/auth";

interface Props {
  email_address?: string;
  disabled?: boolean;
  verify_emails?: boolean;
}

export const EmailAddressSetting = ({
  email_address: email_address0,
  disabled,
}: Props) => {
  const intl = useIntl();
  const [state, setState] = useState<"view" | "edit" | "saving">("view");
  const [showEmailAddress, setShowEmailAddress] = useState<boolean>(false);
  const [password, setPassword] = useState<string>("");
  const [email_address, set_email_address] = useState<string>(
    email_address0 ?? "",
  );
  const [error, setError] = useState<string>("");
  const [message, setMessage] = useState<string>("");

  function start_editing() {
    setState("edit");
    set_email_address(email_address0 ?? "");
    setError("");
    setMessage("");
    setPassword("");
  }

  function cancel_editing() {
    setState("view");
    setPassword("");
  }

  async function save_editing(): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setState("edit");
      setError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
      );
      return;
    }
    setState("saving");
    setMessage("");
    try {
      const result = await webapp_client.account_client.change_email(
        email_address,
        password,
      );
      const changedEmail = result.email_address ?? email_address;
      if (result.already_verified) {
        setMessage(
          `Email address changed to ${changedEmail}. This address was already verified, so no new verification email was needed.`,
        );
      } else if (result.verification_email_sent) {
        setMessage(
          `Email address changed to ${changedEmail}. We sent a verification email to that address.`,
        );
      } else if (result.verification_email_error) {
        setMessage(
          `Email address changed to ${changedEmail}, but sending the verification email failed: ${result.verification_email_error}`,
        );
      } else {
        setMessage(`Email address changed to ${changedEmail}.`);
      }
    } catch (error) {
      setState("edit");
      setError(`Error -- ${error}`);
      return;
    }
    setState("view");
    setError("");
    setPassword("");
  }

  function is_submittable(): boolean {
    return !!(password !== "" && email_address !== email_address0);
  }

  function render_error() {
    if (error) {
      return (
        <ErrorDisplay
          error={error}
          onClose={() => setError("")}
          style={{ marginTop: "15px" }}
        />
      );
    }
  }

  function render_edit() {
    const password_label = intl.formatMessage(
      {
        id: "account.settings.email_address.password_label",
        defaultMessage:
          "{have_email, select, true {Current password} other {Choose a password}}",
      },
      {
        have_email: !!email_address,
      },
    );
    return (
      <Card style={{ marginTop: "3ex" }}>
        <div style={{ marginBottom: "15px" }}>
          <FormattedMessage
            id="account.settings.email_address.new_email_address_label"
            defaultMessage="New email address"
          />
          <Input
            autoFocus
            placeholder="user@example.com"
            onChange={(e) => {
              set_email_address(e.target.value);
            }}
            maxLength={254}
          />
        </div>
        {password_label}
        <Input.Password
          value={password}
          placeholder={password_label}
          onChange={(e) => {
            const pw = e.target.value;
            if (pw != null) {
              setPassword(pw);
            }
          }}
          onPressEnter={() => {
            if (is_submittable()) {
              return save_editing();
            }
          }}
        />
        <Space style={{ marginTop: "15px" }}>
          <Button onClick={cancel_editing}>Cancel</Button>
          <Button
            disabled={!is_submittable()}
            onClick={save_editing}
            type="primary"
          >
            {button_label()}
          </Button>
        </Space>
        {render_error()}
        {render_saving()}
      </Card>
    );
  }

  function render_saving() {
    if (state === "saving") {
      return <Saving />;
    }
  }

  function button_label(): string {
    return intl.formatMessage(
      {
        id: "account.settings.email_address.button_label",
        defaultMessage: `{have_email, select,
      true {Change email address}
      other {Set email address and password}}`,
      },
      {
        have_email: !!email_address,
      },
    );
  }

  const label = intl.formatMessage(labels.email_address);
  const emailDisplayValue =
    email_address === ""
      ? ""
      : showEmailAddress
        ? email_address
        : intl.formatMessage({
            id: "account.settings.email_address.hidden_value",
            defaultMessage: "Hidden",
          });

  return (
    <LabeledRow
      label={label}
      style={disabled ? { color: COLORS.GRAY_M } : undefined}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "10px",
        }}
      >
        <span>{emailDisplayValue}</span>
        {state === "view" ? (
          <Space>
            {email_address ? (
              <Button
                disabled={disabled}
                onClick={() => setShowEmailAddress(!showEmailAddress)}
              >
                {intl.formatMessage(
                  showEmailAddress
                    ? {
                        id: "account.settings.email_address.hide_button",
                        defaultMessage: "Hide",
                      }
                    : {
                        id: "account.settings.email_address.show_button",
                        defaultMessage: "Show",
                      },
                )}
              </Button>
            ) : undefined}
            <Button disabled={disabled} onClick={start_editing}>
              {button_label()}...
            </Button>
          </Space>
        ) : undefined}
      </div>
      {state !== "view" ? render_edit() : undefined}
      {state === "view" && message ? (
        <Alert
          showIcon
          type={message.includes("failed") ? "warning" : "success"}
          title={message}
          style={{ marginTop: "10px" }}
          closable
          onClose={() => setMessage("")}
        />
      ) : null}
    </LabeledRow>
  );
};
