import { useId, useState } from "react";
import { Alert, Switch } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { useAgentMessagingUI } from "@cocalc/frontend/agents/use-ui-preference";
import { AGENT_MESSAGING_UI_SETTING } from "@cocalc/frontend/agents/ui-preference";
import { Panel } from "@cocalc/frontend/antd-bootstrap";

export function AgentMessagingPreference() {
  const enabled = useAgentMessagingUI();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Panel header="Agent Sessions">
      <label id={`${id}-label`} htmlFor={id}>
        Enable Agent Sessions
      </label>{" "}
      <Switch
        id={id}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        checked={enabled}
        disabled={busy}
        loading={busy}
        onChange={async (value) => {
          setBusy(true);
          setError("");
          try {
            await redux
              .getActions("account")
              .set_other_settings_and_wait(AGENT_MESSAGING_UI_SETTING, value);
          } catch {
            setError(
              "Unable to save the agent messaging preference. Try again.",
            );
          } finally {
            setBusy(false);
          }
        }}
      />
      <p id={`${id}-description`}>
        Show agent naming, agent mentions, and two-way Agent Session setup.
        Turning this off hides these controls; it does not pause or close
        sessions and does not revoke external credentials.
      </p>
      <a href="/settings/my-agents">Inspect, pause, or close in Agents</a>
      {error && <Alert role="alert" type="error" title={error} />}
    </Panel>
  );
}
