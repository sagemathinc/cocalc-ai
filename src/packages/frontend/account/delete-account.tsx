/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Input, Modal, Space, theme } from "antd";
import { FormattedMessage, useIntl } from "react-intl";

import {
  Rendered,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { ErrorDisplay, Icon } from "@cocalc/frontend/components";

interface Props {
  confirm: () => void;
  requiredText: string;
}

interface ConfirmationProps {
  confirmationText: string;
  requiredText: string;
  setConfirmationText: (value: string) => void;
}

// Conscious choice to make them type their full name before confirming.
function DeleteAccountConfirmation({
  confirmationText,
  requiredText,
  setConfirmationText,
}: ConfirmationProps) {
  const account_deletion_error = useTypedRedux(
    "account",
    "account_deletion_error",
  );

  function render_error(): Rendered {
    if (account_deletion_error == null) {
      return;
    }
    return <ErrorDisplay error={account_deletion_error} />;
  }

  return (
    <Space vertical>
      <FormattedMessage
        id="account.delete-account.alert.description"
        defaultMessage={`You will immediately lose access to all of your projects,
            any subscriptions will be canceled, and all unspent credit will be lost.`}
      />
      <FormattedMessage
        id="account.delete-account.alert.enter-name"
        defaultMessage={`To delete your account enter "{required_text}" below:`}
        values={{
          required_text: requiredText,
        }}
      />
      <Input
        autoFocus
        value={confirmationText}
        placeholder="Full name"
        type="text"
        onChange={(e) => {
          setConfirmationText((e.target as any).value);
        }}
      />
      {render_error()}
    </Space>
  );
}

function DeleteAccountTitle() {
  return (
    <Space>
      <Icon name="exclamation-triangle" />
      <FormattedMessage
        id="account.delete-account.alert.message"
        defaultMessage={"Are you sure you want to delete your account?"}
      />
    </Space>
  );
}

export function DeleteAccountButton({ confirm, requiredText }: Props) {
  const intl = useIntl();
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const canDeleteAccount = confirmationText === requiredText;

  function close() {
    setOpen(false);
    setConfirmationText("");
  }

  return (
    <>
      <Button
        danger
        onClick={() => {
          setConfirmationText("");
          setOpen(true);
        }}
      >
        <Icon name="trash" />{" "}
        {intl.formatMessage({
          id: "account.delete-account.button",
          defaultMessage: "Delete Account",
        })}
        ...
      </Button>
      {open ? (
        <Modal
          cancelText={intl.formatMessage({
            id: "account.delete-account.modal.cancel",
            defaultMessage: "Cancel",
          })}
          okButtonProps={{
            danger: true,
            disabled: !canDeleteAccount,
          }}
          okText={intl.formatMessage({
            id: "account.delete-account.confirmation",
            defaultMessage: "Yes, delete my account",
          })}
          onCancel={close}
          onOk={() => {
            if (!canDeleteAccount) {
              return;
            }
            confirm();
          }}
          open
          styles={{
            body: { backgroundColor: token.colorErrorBg },
            container: { backgroundColor: token.colorErrorBg },
            footer: { backgroundColor: token.colorErrorBg },
            header: { backgroundColor: token.colorErrorBg },
          }}
          title={<DeleteAccountTitle />}
        >
          <DeleteAccountConfirmation
            confirmationText={confirmationText}
            requiredText={requiredText}
            setConfirmationText={setConfirmationText}
          />
        </Modal>
      ) : undefined}
    </>
  );
}
