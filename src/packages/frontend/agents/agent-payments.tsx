/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// How the signed-in account pays for its agents, for the Agents page: a
// one-line summary per agent and a dialog to change many agents at once.
// The choices live on the server (account home bay); see
// chat/payment-selection-store.

import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Modal,
  Select,
  Space,
  Typography,
} from "antd";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { claudeSubscriptionName } from "@cocalc/frontend/agents/claude-credential-options";
import {
  PAYMENT_SELECTION_EVENT,
  refreshPaymentSelections,
} from "@cocalc/frontend/chat/payment-selection-store";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";
import type { AgentRuntimeSummary } from "@cocalc/util/ai/agent-runtime-kind";
import { CodexCredentialsPanel } from "@cocalc/frontend/account/codex-credentials-panel";
import { ClaudeSubscriptionConnect } from "@cocalc/frontend/chat/claude-subscription-connect";
import type {
  AgentPaymentDefaults,
  AgentPaymentProvider,
  AgentPaymentSelection,
  AgentPaymentSelectionRecord,
  ClaudePaymentSelection,
  CodexPaymentSelection,
} from "@cocalc/util/ai/agent-payment-selection";

export interface PaymentCredential {
  id: string;
  label: string;
  provider: AgentPaymentProvider;
  /** Claude only: subscription or API key. */
  mode?: "account-subscription" | "account-api-key";
  /** ChatGPT only: the account's designated default subscription. */
  isDefault?: boolean;
}

export interface AgentPayments {
  /** By `${project_id}:${thread_id}`. */
  records: Map<string, AgentPaymentSelectionRecord[]>;
  defaults: AgentPaymentDefaults;
  credentials: PaymentCredential[];
  loading: boolean;
  error: string;
}

export const paymentKey = (project_id: string, thread_id: string) =>
  `${project_id}:${thread_id}`;

async function loadCredentials(): Promise<PaymentCredential[]> {
  const system = webapp_client.conat_client.hub.system;
  const [codex, anthropic] = await Promise.all([
    system.getCodexPaymentSource({}).catch(() => undefined),
    system
      .listExternalCredentials({ provider: "anthropic", scope: "account" })
      .catch((): ExternalCredentialInfo[] => []),
  ]);
  const subscriptions = codex?.subscriptions ?? [];
  const ordered = [...subscriptions].sort((a, b) => a.id.localeCompare(b.id));
  return [
    ...subscriptions.map((row) => {
      const index = ordered.findIndex(({ id }) => id === row.id);
      const fallback = index > 0 ? `ChatGPT ${index + 1}` : "ChatGPT";
      return {
        id: row.id,
        provider: "codex" as const,
        label:
          row.label?.trim() ||
          (row.email ? `${fallback} (${row.email})` : fallback),
        isDefault: row.isDefault,
      };
    }),
    ...anthropic
      .filter(
        (row) =>
          !row.revoked &&
          (row.kind === CLAUDE_SUBSCRIPTION_KIND ||
            row.kind === "anthropic-api-key"),
      )
      .map((row) => ({
        id: row.id,
        provider: "claude-code" as const,
        mode:
          row.kind === CLAUDE_SUBSCRIPTION_KIND
            ? ("account-subscription" as const)
            : ("account-api-key" as const),
        label:
          row.kind === CLAUDE_SUBSCRIPTION_KIND
            ? claudeSubscriptionName(row)
            : row.metadata?.label || "Anthropic API key",
      })),
  ];
}

export function useAgentPayments(active: boolean): AgentPayments & {
  reload: () => void;
} {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<AgentPayments>({
    records: new Map(),
    defaults: {},
    credentials: [],
    loading: true,
    error: "",
  });
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Changes from any agent (or another device, on focus) refresh the list.
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((n) => n + 1), 300);
    };
    window.addEventListener(PAYMENT_SELECTION_EVENT, changed);
    window.addEventListener("focus", changed);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(PAYMENT_SELECTION_EVENT, changed);
      window.removeEventListener("focus", changed);
    };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    let canceled = false;
    const agent = webapp_client.conat_client.hub.agent;
    Promise.all([agent.listPaymentSelections({}), loadCredentials()])
      .then(([listed, credentials]) => {
        if (canceled) return;
        const records = new Map<string, AgentPaymentSelectionRecord[]>();
        for (const record of listed.selections) {
          const k = paymentKey(record.project_id, record.thread_id);
          records.set(k, [...(records.get(k) ?? []), record]);
        }
        setState({
          records,
          defaults: listed.defaults ?? {},
          credentials,
          loading: false,
          error: "",
        });
      })
      .catch((err) => {
        if (!canceled)
          setState((old) => ({ ...old, loading: false, error: `${err}` }));
      });
    return () => {
      canceled = true;
    };
  }, [active, revision]);
  return { ...state, reload: () => setRevision((n) => n + 1) };
}

function credentialLabel(credentials: PaymentCredential[], id: string): string {
  return (
    credentials.find((c) => c.id === id)?.label ?? "Unavailable credential"
  );
}

export function selectionLabel(
  selection: AgentPaymentSelection | undefined,
  payments: Pick<AgentPayments, "defaults" | "credentials">,
): string {
  if (!selection || selection.mode === "default") {
    const provider = selection?.provider;
    const fallback = provider ? payments.defaults[provider] : undefined;
    if (provider === "codex" && !fallback) {
      const designated = payments.credentials.find(
        (c) => c.provider === "codex" && c.isDefault,
      );
      return designated ? `Default (${designated.label})` : "Default";
    }
    return fallback
      ? `Default (${selectionLabel(fallback, payments)})`
      : "Default";
  }
  if (selection.mode === "project-secret") return "Project secret";
  return credentialLabel(payments.credentials, selection.credential_id);
}

/** One line for an agent card: how this account pays for it. */
export function agentPaymentSummary(
  payments: AgentPayments,
  agent: {
    project_id: string;
    thread_id: string;
    runtime?: AgentRuntimeSummary;
    /** Live from the name book; preferred over the separately loaded list. */
    payment?: AgentPaymentSelectionRecord[];
  },
): string {
  if (agent.runtime?.kind === "acp") return "Project-managed credentials";
  const records =
    agent.payment ??
    payments.records.get(paymentKey(agent.project_id, agent.thread_id)) ??
    [];
  const provider: AgentPaymentProvider | undefined =
    agent.runtime?.kind === "claude-code"
      ? "claude-code"
      : agent.runtime?.kind === "codex"
        ? "codex"
        : undefined;
  const relevant = provider
    ? records.filter((r) => r.provider === provider)
    : records;
  if (relevant.length === 0) {
    const label = provider
      ? selectionLabel(
          { version: 1, provider, mode: "default" } as AgentPaymentSelection,
          payments,
        )
      : "Default";
    const detail = label.match(/^Default \((.*)\)$/)?.[1];
    return detail
      ? `Paid with your default (${detail})`
      : "Paid with your default";
  }
  return relevant
    .map(
      (r) =>
        `${r.provider === "codex" ? "ChatGPT" : "Claude"}: ${selectionLabel(r.selection, payments)}`,
    )
    .join(" · ");
}

const KEEP = "keep";
const FOLLOW = "default";

export interface PaymentTargetAgent {
  project_id: string;
  thread_id: string;
  path?: string;
  title?: string;
  /** Unknown for agents not yet reported; they get both choices. */
  runtime?: AgentRuntimeSummary;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Which selected agents each provider's choice applies to. */
export function paymentGroups(agents: PaymentTargetAgent[]) {
  return {
    codex: agents.filter((a) => !a.runtime || a.runtime.kind === "codex"),
    claude: agents.filter(
      (a) => !a.runtime || a.runtime.kind === "claude-code",
    ),
    projectManaged: agents.filter((a) => a.runtime?.kind === "acp"),
    unknown: agents.filter((a) => !a.runtime),
  };
}

export function SetPaymentModal({
  open,
  agents,
  payments,
  onClose,
}: {
  open: boolean;
  agents: PaymentTargetAgent[];
  payments: AgentPayments & { reload: () => void };
  onClose: () => void;
}) {
  const [codex, setCodex] = useState(KEEP);
  const [claude, setClaude] = useState(KEEP);
  const [codexDefault, setCodexDefault] = useState(false);
  const [claudeDefault, setClaudeDefault] = useState(false);
  const [connectChatGPT, setConnectChatGPT] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setCodex(KEEP);
    setClaude(KEEP);
    setCodexDefault(false);
    setClaudeDefault(false);
    setError("");
  }, [open]);

  const groups = paymentGroups(agents);
  const codexCredentials = payments.credentials.filter(
    (c) => c.provider === "codex",
  );
  const claudeCredentials = payments.credentials.filter(
    (c) => c.provider === "claude-code",
  );
  const codexOptions = [
    { value: KEEP, label: "Leave unchanged" },
    { value: FOLLOW, label: "Follow my default subscription" },
    ...codexCredentials.map((c) => ({
      value: c.id,
      label: c.isDefault ? `${c.label} (current default)` : c.label,
    })),
  ];
  const claudeOptions = [
    { value: KEEP, label: "Leave unchanged" },
    { value: FOLLOW, label: "Follow my default credential" },
    ...claudeCredentials.map((c) => ({
      value: `${c.mode}:${c.id}`,
      label: c.label,
    })),
    { value: "project-secret", label: "Project secret (ANTHROPIC_API_KEY)" },
  ];

  function codexSelection(value: string): CodexPaymentSelection | null {
    if (value === FOLLOW) return null;
    return {
      version: 1,
      provider: "codex",
      mode: "credential",
      credential_id: value,
    };
  }
  function claudeSelection(value: string): ClaudePaymentSelection | null {
    if (value === FOLLOW) return null;
    if (value === "project-secret")
      return { version: 1, provider: "claude-code", mode: "project-secret" };
    const [mode, id] = value.split(":") as [
      "account-subscription" | "account-api-key",
      string,
    ];
    return { version: 1, provider: "claude-code", mode, credential_id: id };
  }

  async function save() {
    const api = webapp_client.conat_client.hub.agent;
    const targetsOf = (list: PaymentTargetAgent[]) =>
      list.map(({ project_id, thread_id, path, title }) => ({
        project_id,
        thread_id,
        ...(path ? { path } : {}),
        ...(title ? { title } : {}),
      }));
    setSaving(true);
    setError("");
    try {
      const apply = async (
        provider: AgentPaymentProvider,
        list: PaymentTargetAgent[],
        selection: AgentPaymentSelection | null,
        makeDefault: boolean,
      ) => {
        const targets = targetsOf(list);
        if (makeDefault && selection) {
          // Set the default, then these agents follow it.
          await api.setPaymentSelections({ defaults: [provider], selection });
          await api.setPaymentSelections({
            targets,
            selection: null,
            provider,
          });
        } else if (selection) {
          await api.setPaymentSelections({ targets, selection });
        } else {
          await api.setPaymentSelections({
            targets,
            selection: null,
            provider,
          });
        }
      };
      if (codex !== KEEP && groups.codex.length > 0)
        await apply("codex", groups.codex, codexSelection(codex), codexDefault);
      if (claude !== KEEP && groups.claude.length > 0)
        await apply(
          "claude-code",
          groups.claude,
          claudeSelection(claude),
          claudeDefault,
        );
      refreshPaymentSelections();
      payments.reload();
      onClose();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  const n = agents.length;
  const nothing =
    (codex === KEEP || groups.codex.length === 0) &&
    (claude === KEEP || groups.claude.length === 0);
  const codexCount = groups.codex.length - groups.unknown.length;
  const claudeCount = groups.claude.length - groups.unknown.length;
  return (
    <Modal
      open={open}
      title={`Set payment method for ${plural(n, "agent")}`}
      okText="Apply"
      okButtonProps={{ disabled: nothing, loading: saving }}
      onOk={() => void save()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          Applies to turns you start or that agents send to these agents, on
          every device.
        </Typography.Paragraph>
        {groups.codex.length > 0 && (
          <div>
            <Typography.Text strong>
              ChatGPT subscription ·{" "}
              {codexCount > 0 ? plural(codexCount, "Codex agent") : "Codex"}
            </Typography.Text>
            {codexCredentials.length === 0 ? (
              <div style={{ marginTop: 4 }}>
                <Button onClick={() => setConnectChatGPT(true)}>
                  Connect a ChatGPT plan…
                </Button>
              </div>
            ) : (
              <>
                <Select
                  aria-label="ChatGPT subscription for selected agents"
                  value={codex}
                  onChange={setCodex}
                  options={codexOptions}
                  style={{ width: "100%", marginTop: 4 }}
                />
                {codex !== KEEP && codex !== FOLLOW && (
                  <Checkbox
                    checked={codexDefault}
                    onChange={(e) => setCodexDefault(e.target.checked)}
                    style={{ marginTop: 6 }}
                  >
                    Make this my default, so these agents and every agent
                    following the default use it
                  </Checkbox>
                )}
              </>
            )}
          </div>
        )}
        {groups.claude.length > 0 && (
          <div>
            <Typography.Text strong>
              Claude credential ·{" "}
              {claudeCount > 0
                ? plural(claudeCount, "Claude Code agent")
                : "Claude Code"}
            </Typography.Text>
            {claudeCredentials.length === 0 ? (
              <div style={{ marginTop: 4 }}>
                <ClaudeSubscriptionConnect
                  projectId={groups.claude[0].project_id}
                  compact
                  onConnected={(credentialId) => {
                    payments.reload();
                    setClaude(`account-subscription:${credentialId}`);
                  }}
                />
              </div>
            ) : (
              <>
                <Select
                  aria-label="Claude credential for selected agents"
                  value={claude}
                  onChange={setClaude}
                  options={claudeOptions}
                  style={{ width: "100%", marginTop: 4 }}
                />
                {claude !== KEEP && claude !== FOLLOW && (
                  <Checkbox
                    checked={claudeDefault}
                    onChange={(e) => setClaudeDefault(e.target.checked)}
                    style={{ marginTop: 6 }}
                  >
                    Make this my default, so these agents and every agent
                    following the default use it
                  </Checkbox>
                )}
              </>
            )}
          </div>
        )}
        {groups.projectManaged.length > 0 && (
          <Typography.Text type="secondary">
            {plural(groups.projectManaged.length, "agent")} use
            {groups.projectManaged.length === 1 ? "s" : ""} project-managed
            credentials; nothing to set here.
          </Typography.Text>
        )}
        {error && <Alert type="error" title={error} />}
      </Space>
      <Modal
        open={connectChatGPT}
        title="Connect a ChatGPT plan"
        footer={null}
        width={760}
        onCancel={() => {
          setConnectChatGPT(false);
          payments.reload();
        }}
        destroyOnHidden
      >
        <CodexCredentialsPanel
          embedded
          defaultProjectId={groups.codex[0]?.project_id}
          onPaymentSourceChanged={() => payments.reload()}
        />
      </Modal>
    </Modal>
  );
}
