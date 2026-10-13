/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Checkbox, Input, Modal, Space, theme } from "antd";
import { useEffect } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import {
  Rendered,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import api from "@cocalc/frontend/client/api";
import { ErrorDisplay, Icon } from "@cocalc/frontend/components";

interface Props {
  // purge_client_ids: the sites (e.g. Sagebrush) whose data to also delete;
  // undefined means all of them.
  confirm: (purge_client_ids?: string[]) => void;
  requiredText: string;
}

// A site the account signed in to with CoCalc, whose data can be deleted too.
interface OAuthClientApproval {
  client_id: string;
  name: string;
}

interface ConfirmationProps {
  confirmationText: string;
  requiredText: string;
  setConfirmationText: (value: string) => void;
  clients: OAuthClientApproval[];
  keep: Set<string>;
  setKeep: (keep: Set<string>) => void;
}

// Conscious choice to make them type their full name before confirming.
function DeleteAccountConfirmation({
  confirmationText,
  requiredText,
  setConfirmationText,
  clients,
  keep,
  setKeep,
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
      {clients.map(({ client_id, name }) => (
        <Checkbox
          key={client_id}
          checked={!keep.has(client_id)}
          onChange={(e) => {
            const next = new Set(keep);
            if (e.target.checked) {
              next.delete(client_id);
            } else {
              next.add(client_id);
            }
            setKeep(next);
          }}
        >
          <FormattedMessage
            id="account.delete-account.purge-client"
            defaultMessage="Also delete my {name} shared files"
            values={{ name }}
          />
        </Checkbox>
      ))}
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
  // undefined until loaded; the purge then covers every client.
  const [clients, setClients] = useState<OAuthClientApproval[] | undefined>();
  // Clients whose data the user chose to keep.
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const canDeleteAccount = confirmationText === requiredText;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setClients(undefined);
    setKeep(new Set());
    void (async () => {
      try {
        const result = await api("/accounts/oauth-client-approvals");
        if (!cancelled) setClients(result?.clients ?? []);
      } catch {
        // Without the list the dialog shows no options and deletion purges
        // every client's data, which is the default anyway.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

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
            confirm(
              clients
                ?.map(({ client_id }) => client_id)
                .filter((client_id) => !keep.has(client_id)),
            );
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
            clients={clients ?? []}
            keep={keep}
            setKeep={setKeep}
          />
        </Modal>
      ) : undefined}
    </>
  );
}
