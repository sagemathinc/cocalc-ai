import { useId, useState } from "react";
import { Alert, Switch } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { useMyAgentsUI } from "@cocalc/frontend/agents/use-workspace-ui-preference";
import { MY_AGENTS_UI_SETTING } from "@cocalc/frontend/agents/workspace-ui-preference";

export function MyAgentsPreference() {
  const enabled = useMyAgentsUI();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section aria-labelledby={`${id}-title`} style={{ marginBlock: 24 }}>
      <h3 id={`${id}-title`}>My Agents workspace</h3>
      <label id={`${id}-label`} htmlFor={id}>
        Enable My Agents Page (Experimental)
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
              .set_other_settings_and_wait(MY_AGENTS_UI_SETTING, value);
          } catch {
            setError("Unable to save the My Agents preference. Try again.");
          } finally {
            setBusy(false);
          }
        }}
      />
      <p id={`${id}-description`}>
        Show My Agents as a main workspace for your registered agents and open
        it after normal sign-in. Explicit links and document return URLs still
        open their requested destination. This is a rollout preference, not a
        permission boundary. Turning it off hides the workspace but does not
        stop agents, revoke connections, or remove project access.
      </p>
      <a href="/docs/ai/my-agents">Learn about the experimental workspace</a>
      {error && <Alert role="alert" type="error" title={error} />}
    </section>
  );
}
