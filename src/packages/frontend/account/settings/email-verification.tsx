/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map } from "immutable";
import { Button } from "antd";
import { defineMessage, FormattedMessage, useIntl } from "react-intl";

import { alert_message } from "@cocalc/frontend/alerts";
import {
  Rendered,
  useEffect,
  useIsMountedRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { LabeledRow } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";

interface Props {
  email_address?: string;
  email_address_verified?: Map<string, boolean>;
}

export const emailVerificationMsg = defineMessage({
  id: "account.settings.email-verification.button.status",
  defaultMessage: `{state, select,
    sending {Sending...}
    sent {Verification Email Sent}
    other {Send Verification Email}}`,
});

export function EmailVerification({
  email_address,
  email_address_verified,
}: Props) {
  const intl = useIntl();

  const is_mounted = useIsMountedRef();
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent">(
    "idle",
  );

  useEffect(() => {
    setSendState("idle");
  }, [email_address]);

  async function verify(): Promise<void> {
    if (sendState !== "idle") {
      return;
    }
    setSendState("sending");
    try {
      await webapp_client.account_client.send_verification_email();
      if (is_mounted.current) {
        setSendState("sent");
      }
    } catch (err) {
      const err_msg = `Problem sending email verification: ${err}`;
      console.log(err_msg);
      alert_message({ type: "error", message: err_msg });
      if (is_mounted.current) {
        setSendState("idle");
      }
    }
  }

  function render_status(): Rendered {
    if (email_address == null) {
      return (
        <span>
          <FormattedMessage
            id="account.settings.email-verification.unknown"
            defaultMessage={"Unknown"}
          />
        </span>
      );
    } else {
      if (email_address_verified?.get(email_address)) {
        return (
          <span style={{ color: "green" }}>
            <FormattedMessage
              id="account.settings.email-verification.verified"
              defaultMessage={"Verified"}
            />
          </span>
        );
      } else {
        return (
          <span>
            <span style={{ color: "red", paddingRight: "3em" }}>
              <FormattedMessage
                id="account.settings.email-verification.button.label"
                defaultMessage={"Not Verified"}
              />
            </span>
            <Button
              key="send-verification-email"
              onClick={verify}
              type="primary"
              loading={sendState === "sending"}
              disabled={sendState !== "idle"}
            >
              {intl.formatMessage(emailVerificationMsg, { state: sendState })}
            </Button>
          </span>
        );
      }
    }
  }

  return (
    <LabeledRow
      label={intl.formatMessage({
        id: "account.settings.email-verification.label",
        defaultMessage: "Email verification",
      })}
      style={{ marginBottom: "15px" }}
    >
      <div>
        <FormattedMessage
          id="account.settings.email-verification.status_label"
          defaultMessage={"Status:"}
        />{" "}
        {render_status()}
      </div>
    </LabeledRow>
  );
}
