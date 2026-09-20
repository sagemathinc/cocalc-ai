import { useEffect, useState } from "react";
import { Alert, Button, Space, Tag } from "antd";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import type { AgentNetwork } from "@cocalc/conat/agents/personal";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";

type Api = Pick<AgentApi, "resolveIdentity" | "listAgentNetworks">;

export function AgentCommunication({
  api,
  projectId,
  path,
  threadId,
}: {
  api: Api;
  projectId: string;
  path: string;
  threadId: string;
  accountId: string;
}) {
  const [open, setOpen] = useState(false);
  const [networks, setSessions] = useState<AgentNetwork[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const identity = await api.resolveIdentity({
          project_id: projectId,
          path,
          thread_id: threadId,
        });
        if (!identity) {
          if (!disposed) setSessions([]);
          return;
        }
        const directory = await api.listAgentNetworks({ limit: 100 });
        if (!disposed)
          setSessions(
            directory.networks.filter((session) =>
              session.members.some(
                (member) =>
                  member.kind === "registered" &&
                  member.endpoint.project_id === projectId &&
                  member.endpoint.agent_id === identity.agent_id,
              ),
            ),
          );
      } catch (err) {
        if (!disposed) setError(`${err}`);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [api, open, path, projectId, threadId]);

  return (
    <section aria-label="Agent Networks" style={{ marginTop: 16 }}>
      <Button size="small" aria-expanded={open} onClick={() => setOpen(!open)}>
        Agent Networks
      </Button>
      {open && (
        <Space orientation="vertical" style={{ width: "100%", marginTop: 8 }}>
          {error && (
            <Alert
              type="error"
              title="Unable to load Agent Networks"
              description={error}
            />
          )}
          {!loading && !error && networks.length === 0 && (
            <span>This agent is not in an Agent Network.</span>
          )}
          {networks.map((session) => (
            <div key={session.agent_network_id}>
              <strong>{session.title || "Untitled Agent Network"}</strong>{" "}
              <Tag>{session.state}</Tag>
              <Tag>{session.delivery_mode}</Tag>
              <span>{session.members.length} members</span>
            </div>
          ))}
          {!error && (
            <Button
              size="small"
              onClick={() => openAccountSettings({ page: "my-agents" })}
            >
              Manage Agent Networks
            </Button>
          )}
        </Space>
      )}
    </section>
  );
}
