import { useState } from "react";
import type { ReactNode } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

/** Resolve the current, authorized identity rather than storing a stale chat path. */
export function PeerAgentLink({
  target,
  label,
  children,
}: {
  target: { project_id: string; agent_id: string };
  label: string;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    setBusy(true);
    setError("");
    try {
      const { personalAgentApi } = await import("./api");
      const identity = await personalAgentApi().getIdentity(target);
      if (identity.disabled_at) throw new Error("This agent is unavailable");
      const { openAgentNotification } = await import("./open-notification");
      if (
        await openAgentNotification(
          identity.project_id,
          identity.path,
          identity.thread_id,
        )
      )
        return;
      const { openAgentThread } = await import("./open-agent");
      await openAgentThread(identity);
    } catch (err) {
      setError(`Unable to open agent: ${err}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span contentEditable={false}>
      <button
        type="button"
        aria-label={`Open agent ${label}`}
        disabled={busy}
        onClick={() => void open()}
        style={{
          font: "inherit",
          color: UI_COLORS.link,
          background: "transparent",
          border: 0,
          padding: "4px 0",
          cursor: "pointer",
        }}
      >
        {children}
      </button>
      {error && (
        <span role="alert" style={{ whiteSpace: "normal" }}>
          {error}
        </span>
      )}
    </span>
  );
}
