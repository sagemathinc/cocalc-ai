import { useRef, useState } from "react";
import { Alert, Button, Modal, Space } from "antd";
import { defineMessage } from "react-intl";
import type { SetPersonalMessagingStateOptions } from "@cocalc/conat/agents/personal";
import { ExternalAgentInstallations } from "@cocalc/frontend/agents/external-installations";
import {
  personalAgentApi,
  refreshNamedAgents,
  useNamedAgents,
} from "@cocalc/frontend/agents/api";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { SettingsPageDefinition } from "./settings-page";

export function MyAgentsPage() {
  const accountId = useTypedRedux("account", "account_id");
  return accountId ? <AccountAgentsPage key={accountId} /> : null;
}

function AccountAgentsPage() {
  const { directory, error: directoryError } = useNamedAgents();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);

  async function accountAction(
    action: SetPersonalMessagingStateOptions["action"],
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await personalAgentApi().setPersonalMessagingState({ action });
      setNotice(
        action === "pause"
          ? "All future agent messaging is paused."
          : action === "resume"
            ? "Agent messaging resumed."
            : "All Agent Networks were closed and account messaging authority was revoked.",
      );
      refreshNamedAgents();
      setRevision((value) => value + 1);
    } catch (err) {
      setError(`${err}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <Space
      orientation="vertical"
      size="large"
      style={{ width: "100%", maxWidth: 1000, minWidth: 0 }}
    >
      <div>
        <h1 style={{ marginBottom: 4 }}>Agent messaging</h1>
        <p>
          These account-wide controls affect all Agent Networks and external
          agent installations. Manage individual agents and network tags in the
          Agents workspace.
        </p>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button
          disabled={busy || !directory?.controls}
          onClick={() =>
            void accountAction(directory?.controls?.paused ? "resume" : "pause")
          }
        >
          {directory?.controls?.paused
            ? "Resume all messaging"
            : "Pause all messaging"}
        </Button>
        <Button
          danger
          disabled={busy || !directory?.controls}
          onClick={() =>
            Modal.confirm({
              title: "Revoke all Agent Networks?",
              content:
                "This permanently closes every Agent Network and changes the account authorization generation. Already accepted work is not canceled.",
              okText: "Revoke all",
              okButtonProps: { danger: true },
              onOk: () => accountAction("revoke_all"),
            })
          }
        >
          Revoke all networks
        </Button>
      </div>
      {(directoryError || error) && (
        <div role="alert">
          <Alert
            type="error"
            title="Agents needs attention"
            description={directoryError || error}
          />
        </div>
      )}
      {notice && <div role="status">{notice}</div>}
      {directory?.controls?.paused && (
        <Alert type="warning" title="All agent messaging is paused" />
      )}
      <ExternalAgentInstallations revision={revision} />
    </Space>
  );
}

export const MY_AGENTS_SETTINGS_PAGE = {
  component: MyAgentsPage,
  description: defineMessage({
    id: "account.settings.my-agents.description",
    defaultMessage: "Account-wide messaging and external installations.",
  }),
  icon: "robot",
  key: "my-agents",
  label: defineMessage({
    id: "account.settings.my-agents.label",
    defaultMessage: "Agent messaging",
  }),
} satisfies SettingsPageDefinition;
