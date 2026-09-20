import { useRef, useState } from "react";
import { Alert, Button, Card, Input, Modal, Space, Tag } from "antd";
import { defineMessage } from "react-intl";
import type { SetPersonalMessagingStateOptions } from "@cocalc/conat/agents/personal";
import { NameAgent } from "@cocalc/frontend/agents/name-agent";
import { AgentSessions } from "@cocalc/frontend/agents/agent-sessions";
import { ExternalAgentInstallations } from "@cocalc/frontend/agents/external-installations";
import {
  personalAgentApi,
  refreshNamedAgents,
  useNamedAgents,
} from "@cocalc/frontend/agents/api";
import { openAgentThread } from "@cocalc/frontend/agents/open-agent";
import { NamedAgentLimitAlert } from "@cocalc/frontend/agents/agent-limit";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { SettingsPageDefinition } from "./settings-page";

export function MyAgentsPage() {
  const accountId = useTypedRedux("account", "account_id");
  return accountId ? <AccountAgentsPage key={accountId} /> : null;
}

function AccountAgentsPage() {
  const { directory, error: directoryError, loading } = useNamedAgents();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string>();
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
            : "All Agent Sessions were closed and account messaging authority was revoked.",
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

  const search = query.trim().toLowerCase().replace(/^@/, "");
  const agents = (directory?.agents ?? [])
    .filter((agent) =>
      `${agent.name} ${agent.thread_title ?? ""} ${agent.project_title ?? ""}`
        .toLowerCase()
        .includes(search),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Space
      orientation="vertical"
      size="large"
      style={{ width: "100%", maxWidth: 1000, minWidth: 0 }}
    >
      <div>
        <h1 style={{ marginBottom: 4 }}>Agents</h1>
        <p>
          Name reusable agents and put them in Agent Sessions. Every active
          session is a two-way communication group; named agents alone cannot
          message one another.
        </p>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Input.Search
          aria-label="Search Agents"
          placeholder="Name, thread or project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ maxWidth: "100%", width: 300 }}
        />
        <Button
          loading={loading}
          disabled={busy}
          onClick={() => {
            refreshNamedAgents();
            setRevision((value) => value + 1);
          }}
        >
          Refresh Agents
        </Button>
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
              title: "Revoke all Agent Sessions?",
              content:
                "This permanently closes every Agent Session and changes the account authorization generation. Already accepted work is not canceled.",
              okText: "Revoke all",
              okButtonProps: { danger: true },
              onOk: () => accountAction("revoke_all"),
            })
          }
        >
          Revoke all sessions
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
      <NamedAgentLimitAlert directory={directory} />
      <section aria-labelledby="named-agents-heading">
        <h2 id="named-agents-heading">Named Agents</h2>
        {!loading && directory?.enabled && agents.length === 0 && (
          <p>
            No matching agents. Name an agent beside its thread title to make it
            available here without starting a turn.
          </p>
        )}
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {agents.map((agent) => (
            <Card
              key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}
              size="small"
              title={`@${agent.name}`}
              extra={<Tag>{agent.available ? "Available" : "Unavailable"}</Tag>}
            >
              <Space orientation="vertical" style={{ width: "100%" }}>
                <div>
                  {agent.thread_title ?? "Agent thread"} /{" "}
                  {agent.project_title ?? "Project"}
                </div>
                {agent.description && <p>{agent.description}</p>}
                <Space wrap>
                  <Button
                    loading={opening === agent.endpoint.agent_id}
                    disabled={!agent.available || opening !== undefined}
                    onClick={async () => {
                      setOpening(agent.endpoint.agent_id);
                      setError("");
                      try {
                        await openAgentThread({
                          project_id: agent.endpoint.project_id,
                          path: agent.path,
                          thread_id: agent.thread_id,
                        });
                      } catch (err) {
                        setError(`${err}`);
                      } finally {
                        setOpening(undefined);
                      }
                    }}
                  >
                    Open
                  </Button>
                  <NameAgent
                    agent={agent}
                    projectId={agent.endpoint.project_id}
                    path={agent.path}
                    threadId={agent.thread_id}
                    threadTitle={agent.thread_title}
                    projectTitle={agent.project_title}
                  />
                  <Button
                    danger
                    disabled={busy}
                    onClick={() =>
                      Modal.confirm({
                        title: `Remove @${agent.name} from Agents?`,
                        content:
                          "This frees a named-agent slot. The conversation and artifacts are preserved, and historical Agent Sessions keep their records, but this agent becomes unavailable to those sessions.",
                        okText: "Remove from Agents",
                        okButtonProps: { danger: true },
                        onOk: async () => {
                          setBusy(true);
                          try {
                            await personalAgentApi().retireNamedAgent({
                              endpoint: agent.endpoint,
                            });
                            refreshNamedAgents();
                          } finally {
                            setBusy(false);
                          }
                        },
                      })
                    }
                  >
                    Remove from Agents
                  </Button>
                </Space>
                <details>
                  <summary>Agent identifiers</summary>
                  <p>Project: {agent.endpoint.project_id}</p>
                  <p>Agent: {agent.endpoint.agent_id}</p>
                  <p>Thread: {agent.thread_id}</p>
                  <p>Path: {agent.path}</p>
                </details>
              </Space>
            </Card>
          ))}
        </Space>
      </section>
      <AgentSessions key={revision} agents={directory?.agents ?? []} />
      <ExternalAgentInstallations revision={revision} />
    </Space>
  );
}

export const MY_AGENTS_SETTINGS_PAGE = {
  component: MyAgentsPage,
  description: defineMessage({
    id: "account.settings.my-agents.description",
    defaultMessage: "Your named agents and two-way Agent Sessions.",
  }),
  icon: "robot",
  key: "my-agents",
  label: defineMessage({
    id: "account.settings.my-agents.label",
    defaultMessage: "Agents",
  }),
} satisfies SettingsPageDefinition;
