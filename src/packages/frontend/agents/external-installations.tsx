import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space } from "antd";
import type { ExternalAgentInstallation } from "@cocalc/conat/agents/external";
import { postAuthApi } from "@cocalc/frontend/auth/api";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import { useBoundAgentAccount } from "./use-bound-account";

interface Directory {
  enabled: boolean;
  installations: ExternalAgentInstallation[];
}

export function ExternalAgentInstallations({
  revision = 0,
}: {
  revision?: number;
}) {
  const [directory, setDirectory] = useState<Directory>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const bound = useBoundAgentAccount();
  const heading = useRef<HTMLHeadingElement>(null);
  const origin = getControlPlaneOrigin();
  useEffect(() => {
    let disposed = false;
    postAuthApi<Directory>({
      origin,
      endpoint: "auth/cli/agent/installations",
      body: { action: "list" },
    })
      .then((value) => {
        if (!disposed) setDirectory(value);
      })
      .catch((err) => {
        if (!disposed) setError(`${err}`);
      });
    return () => {
      disposed = true;
    };
  }, [origin, revision]);

  async function revoke(installation_id: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      bound.assertCurrent();
      const value = await postAuthApi<Directory>({
        origin,
        endpoint: "auth/cli/agent/installations",
        body: { action: "revoke", installation_id },
      });
      bound.assertCurrent();
      setDirectory(value);
      setNotice("Installation revoked. Already accepted work is not canceled.");
      heading.current?.focus();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }

  if (!directory && !error) return null;
  return (
    <section aria-label="External agent installations">
      <h3 ref={heading} tabIndex={-1}>
        External Agent Installations
      </h3>
      <p>
        Network-scoped credentials for agents on other computers or sites. Each
        installation sends and receives only within its approved Agent Network.
        Account pause and revoke-all also apply.
      </p>
      {error && <Alert type="error" role="alert" title={error} />}
      {notice && <p role="status">{notice}</p>}
      <Space orientation="vertical" style={{ width: "100%" }}>
        {directory?.installations.length === 0 && (
          <p>No external installations approved.</p>
        )}
        {directory?.installations.map((item) => {
          const active =
            item.state === "active" && Date.parse(item.expires_at) > Date.now();
          return (
            <Card key={item.installation_id} size="small" title={item.label}>
              <p>
                {item.state === "revoked"
                  ? "Revoked"
                  : active
                    ? "Active unless account communication is paused"
                    : "Expired"}
                . Expires {new Date(item.expires_at).toLocaleString()}.
              </p>
              <p>
                Agent Network <code>{item.agent_network_id}</code>. Installation{" "}
                <code style={{ overflowWrap: "anywhere" }}>
                  {item.installation_id}
                </code>
                .
              </p>
              {active && (
                <Button
                  danger
                  disabled={busy}
                  onClick={() => void revoke(item.installation_id)}
                  aria-label={`Revoke ${item.label}`}
                >
                  Revoke
                </Button>
              )}
            </Card>
          );
        })}
      </Space>
    </section>
  );
}
