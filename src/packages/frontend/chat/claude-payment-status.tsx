import { Button, Popover, Progress, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import {
  CLAUDE_USAGE_METADATA_KEY,
  claudeSubscriptionUsage,
} from "@cocalc/util/ai/claude-usage";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { claudeSubscriptionName } from "@cocalc/frontend/agents/claude-credential-options";
import {
  HARNESS_CREDENTIAL_SELECTION_EVENT,
  readHarnessCredentialSelection,
} from "./harness-credential-selection";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { ClaudeUsageLimitWarning } from "./claude-credential-list";

const CLAUDE_CREDENTIALS_EVENT = "cocalc:claude-credentials";
const CLAUDE_CREDENTIALS_MAX_AGE_MS = 60_000;
let claudeCredentials:
  | { at: number; promise: Promise<ExternalCredentialInfo[]> }
  | undefined;

/**
 * The account's Claude credentials (one list call, shared by every footer),
 * reused for a minute unless fresh is asked for.
 */
export function listClaudeCredentials(
  fresh = false,
): Promise<ExternalCredentialInfo[]> {
  if (
    fresh ||
    !claudeCredentials ||
    Date.now() - claudeCredentials.at > CLAUDE_CREDENTIALS_MAX_AGE_MS
  ) {
    const promise = webapp_client.conat_client.hub.system
      .listExternalCredentials({ provider: "anthropic", scope: "account" })
      .catch((err) => {
        if (claudeCredentials?.promise === promise)
          claudeCredentials = undefined;
        throw err;
      });
    claudeCredentials = { at: Date.now(), promise };
    void promise.then(
      () => window.dispatchEvent(new Event(CLAUDE_CREDENTIALS_EVENT)),
      () => {},
    );
  }
  return claudeCredentials.promise;
}

/** Settings changed the list (connect, rename, disconnect): show it at once. */
export function setClaudeCredentials(rows: ExternalCredentialInfo[]): void {
  claudeCredentials = { at: Date.now(), promise: Promise.resolve(rows) };
  window.dispatchEvent(new Event(CLAUDE_CREDENTIALS_EVENT));
}

/** Called whenever the shared list changes (a reload, or an edit in settings). */
export function onClaudeCredentialsChanged(listener: () => void): () => void {
  window.addEventListener(CLAUDE_CREDENTIALS_EVENT, listener);
  return () => window.removeEventListener(CLAUDE_CREDENTIALS_EVENT, listener);
}

export function clearClaudeCredentialsForTests(): void {
  claudeCredentials = undefined;
}

// The selected account credential's row, kept current as the list changes.
function useClaudeCredential(
  credentialId: string | undefined,
): ExternalCredentialInfo | undefined {
  const [row, setRow] = useState<ExternalCredentialInfo>();
  useEffect(() => {
    // Never show another credential's name while (or if) this one loads.
    setRow(undefined);
    if (!credentialId) return;
    let active = true;
    const load = () =>
      void listClaudeCredentials()
        .then((rows) => {
          if (active)
            setRow(
              rows.find(({ id, revoked }) => id === credentialId && !revoked),
            );
        })
        .catch(() => {});
    load();
    window.addEventListener(CLAUDE_CREDENTIALS_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(CLAUDE_CREDENTIALS_EVENT, load);
    };
  }, [credentialId]);
  // Synchronous guard: the render right after a switch still holds the old
  // row until the effect clears it.
  return row?.id === credentialId ? row : undefined;
}

/**
 * The footer name of a payment source: a subscription's own name (its label,
 * else plan and email), an API key's label, else the generic kind.
 */
export function claudePaymentName(
  mode: string | undefined,
  row: ExternalCredentialInfo | undefined,
): string {
  const label = claudePaymentLabel(mode);
  if (!row) return label;
  if (mode === "account-subscription") return claudeSubscriptionName(row, true);
  const named = `${row.metadata?.label ?? ""}`.trim();
  return mode === "account-api-key" && named ? named : label;
}

export function claudePaymentLabel(mode: string | undefined): string {
  return mode === "account-subscription"
    ? "Claude subscription"
    : mode === "account-api-key"
      ? "Account API key"
      : mode === "site-funded"
        ? "CoCalc Membership"
        : "Project API key";
}

// The short label of the payment source selected for a thread.
export function useClaudePaymentLabel(
  projectId: string | undefined,
  threadKey: string | undefined,
): string | undefined {
  const accountId = useTypedRedux("account", "account_id");
  const [, setVersion] = useState(0);
  useEffect(() => {
    const update = () => setVersion((value) => value + 1);
    window.addEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  const selection =
    projectId && threadKey
      ? readHarnessCredentialSelection({ accountId, projectId, threadKey })
      : undefined;
  const row = useClaudeCredential(
    selection?.mode === "account-subscription" ||
      selection?.mode === "account-api-key"
      ? selection.credentialId
      : undefined,
  );
  if (!projectId || !threadKey) return undefined;
  return claudePaymentName(selection?.mode, row);
}

export function ClaudePaymentStatus({
  projectId,
  threadKey,
  onConfigure,
}: {
  projectId: string;
  threadKey: string;
  onConfigure: () => void;
}) {
  const accountId = useTypedRedux("account", "account_id");
  const [, setVersion] = useState(0);
  useEffect(() => {
    const update = () => setVersion((value) => value + 1);
    window.addEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  const credential = readHarnessCredentialSelection({
    accountId,
    projectId,
    threadKey,
  });
  const credentialId =
    credential?.mode === "account-subscription" ||
    credential?.mode === "account-api-key"
      ? credential.credentialId
      : undefined;
  return (
    <PaymentStatus
      key={JSON.stringify([accountId, projectId, credential])}
      credentialId={credentialId}
      mode={credential?.mode ?? "project-secret"}
      onConfigure={onConfigure}
    />
  );
}

function PaymentStatus({
  credentialId,
  mode,
  onConfigure,
}: {
  credentialId?: string;
  mode: string;
  onConfigure: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const credential = useClaudeCredential(credentialId);
  const [loading, setLoading] = useState(false);
  const subscription = mode === "account-subscription";
  const label = claudePaymentLabel(mode);
  // Opening the details reloads, so the usage shown is the latest stored.
  useEffect(() => {
    if (!open || !credentialId) return;
    let active = true;
    setLoading(true);
    void listClaudeCredentials(true)
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, credentialId]);
  const name =
    subscription && credential
      ? claudeSubscriptionName(credential)
      : credential?.metadata?.label;
  const buttonLabel = claudePaymentName(mode, credential);
  // Saved from the limits Claude reports with each response of a turn.
  const usage = claudeSubscriptionUsage(
    credential?.metadata?.[CLAUDE_USAGE_METADATA_KEY],
  );
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={["hover", "focus"]}
      content={
        <KeyboardBoundary
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              trigger.current?.focus();
              setOpen(false);
              event.stopPropagation();
            }
          }}
        >
          <div style={{ width: 290, maxWidth: "calc(100vw - 48px)" }}>
            <Typography.Text strong>{label}</Typography.Text>
            {name && name !== label && <div>{name}</div>}
            {subscription ? (
              <>
                <div role="status">
                  {loading && !credential
                    ? "Loading subscription usage..."
                    : !usage
                      ? "Usage appears here after your next Claude turn."
                      : ""}
                </div>
                {usage?.windows.map((window) => (
                  <div key={window.name} style={{ marginTop: 12 }}>
                    <div>
                      {window.name}: {window.usedPercent}% used{" "}
                      <ClaudeUsageLimitWarning window={window} />
                    </div>
                    <Progress
                      percent={window.usedPercent}
                      status="normal"
                      showInfo={false}
                      size="small"
                    />
                    <Typography.Text type="secondary">
                      {window.resetSinceObserved ? "Reset " : "Resets "}
                      <TimeAgo date={window.resetsAt} />
                      {window.resetSinceObserved ? " (since this update)" : ""}
                    </Typography.Text>
                  </div>
                ))}
                {usage && (
                  <div style={{ marginTop: 8 }}>
                    <Typography.Text type="secondary">
                      Updated <TimeAgo date={usage.observedAt} />, as of your
                      latest Claude turn in CoCalc. Use elsewhere since then
                      (claude.ai or other apps) is not included.
                    </Typography.Text>
                  </div>
                )}
                <a
                  href="https://claude.ai/settings/usage"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View usage on Claude
                </a>
              </>
            ) : (
              <p>Anthropic bills API usage to the key owner.</p>
            )}
          </div>
        </KeyboardBoundary>
      }
    >
      <Button
        ref={trigger}
        type="text"
        size="small"
        onClick={() => {
          setOpen(false);
          onConfigure();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.stopPropagation();
          }
        }}
        aria-label={`${buttonLabel}: payment settings`}
        aria-haspopup="dialog"
      >
        {buttonLabel}
      </Button>
    </Popover>
  );
}
