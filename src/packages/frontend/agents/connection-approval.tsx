import { useEffect, useId, useRef, useState } from "react";
import { Alert, Checkbox, Modal, Select, Space } from "antd";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { uuid } from "@cocalc/util/misc";
import { personalAgentApi } from "./api";
import { useBoundAgentAccount } from "./use-bound-account";
import { useSourceAgentName } from "./source-agent-name";
import type { AgentNameContext } from "./name-context";
import { cachedAgentNameContext } from "./name-context";

export interface ApprovalTarget {
  source: AgentEndpoint;
  target: AgentEndpoint;
  sourceLabel: string;
  targetLabel: string;
  sourceName?: NamedAgent;
  sourceContext?: AgentNameContext;
  targetName?: NamedAgent;
  namingAccountId?: string;
  bothDirections?: boolean;
}

export function ConnectionApproval({
  value,
  onClose,
}: {
  value: ApprovalTarget;
  onClose: (approved: boolean) => void;
}) {
  const id = useId();
  const accountId = useTypedRedux("account", "account_id");
  const boundAccount = useBoundAgentAccount();
  const [ttl, setTtl] = useState<number | null>(86400);
  const [bothDirections, setBothDirections] = useState(
    value.bothDirections ?? false,
  );
  const [busy, setBusy] = useState(false);
  const sourceNaming = useSourceAgentName(
    value.source,
    value.sourceName,
    busy,
    value.sourceContext,
  );
  const sourceContext = value.sourceContext
    ? cachedAgentNameContext(value.sourceContext)
    : undefined;
  const [error, setError] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  async function approve() {
    if (lock.current || !sourceNaming.canApprove) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const key = JSON.stringify([
        value.source,
        value.target,
        ttl,
        bothDirections,
      ]);
      if (attempt.current?.key !== key) attempt.current = { key, id: uuid() };
      const requestId = attempt.current.id;
      const completed = await runFreshAuthAction(async () => {
        boundAccount.assertCurrent();
        if (!alive.current)
          throw new Error(
            "The approval context changed. Review the connection again.",
          );
        await sourceNaming.ensureNamed();
        boundAccount.assertCurrent();
        if (!alive.current)
          throw new Error(
            "The approval context changed. Review the connection again.",
          );
        await personalAgentApi().grantPersonalConnection({
          source: value.source,
          target: value.target,
          approval_request_id: requestId,
          ttl_seconds: ttl,
          both_directions: bothDirections,
          reason: "Human selected a named agent in the composer",
        });
      });
      onClose(completed);
    } catch (err) {
      setError(`${err}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!boundAccount.current) return null;
  return (
    <>
      <Modal
        open
        title="Approve agent communication"
        okText="Approve connection"
        confirmLoading={busy}
        okButtonProps={{ disabled: busy || !sourceNaming.canApprove }}
        onOk={() => void approve()}
        onCancel={() => {
          if (!busy) onClose(false);
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <p>
            <strong>
              {sourceNaming.known
                ? `@${sourceNaming.known.name}`
                : value.sourceLabel}
            </strong>{" "}
            may message <strong>{value.targetLabel}</strong> under your account.
          </p>
          <div>
            From:{" "}
            {sourceContext?.thread_title ??
              sourceNaming.known?.thread_title ??
              value.sourceLabel}{" "}
            /{" "}
            {sourceContext?.project_title ??
              sourceNaming.known?.project_title ??
              "Project name unavailable"}
          </div>
          <div>
            To: {value.targetName?.thread_title ?? value.targetLabel} /{" "}
            {value.targetName?.project_title ?? "Project name unavailable"}
          </div>
          {sourceNaming.field}
          {value.namingAccountId && value.namingAccountId !== accountId && (
            <p>
              This reference was named in another account. You are approving
              your own connection to the same agent, not using that account's
              permissions.
            </p>
          )}
          {value.targetName &&
            value.targetLabel !== `@${value.targetName.name}` && (
              <p>
                {value.namingAccountId === accountId
                  ? "This agent is now named"
                  : "This agent is named"}{" "}
                <strong>@{value.targetName.name}</strong> in your directory. The
                selected reference still points to the same agent.
              </p>
            )}
          <label htmlFor={`${id}-duration`}>Connection duration</label>
          <Select
            id={`${id}-duration`}
            aria-label="Connection duration"
            value={ttl ?? "never"}
            disabled={busy}
            style={{ width: "100%" }}
            onChange={(value) =>
              setTtl(value === "never" ? null : Number(value))
            }
            options={[
              { value: 3600, label: "1 hour" },
              { value: 86400, label: "1 day" },
              { value: 2592000, label: "30 days" },
              { value: "never", label: "Never expires" },
            ]}
          />
          <Checkbox
            checked={bothDirections}
            disabled={busy}
            onChange={(event) => setBothDirections(event.target.checked)}
          >
            Allow communication in both directions
          </Checkbox>
          <p>
            Approval creates permission, not a send. Messages queue behind busy
            turns. This does not grant project access or cancel already accepted
            work. Your private draft is preserved if you cancel.
          </p>
          <details>
            <summary>Endpoint details</summary>
            {value.namingAccountId && (
              <p>
                Reference name snapshot: {value.targetLabel}, originally named
                by {value.namingAccountId}.{" "}
                {value.targetName &&
                  `Current name in your directory: @${value.targetName.name}.`}{" "}
                Approval uses your own authority for this exact target, not the
                original naming account's permissions.
              </p>
            )}
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(
                { source: value.source, target: value.target },
                null,
                2,
              )}
            </pre>
          </details>
          {error && (
            <div role="alert">
              <Alert type="error" title={error} />
            </div>
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
