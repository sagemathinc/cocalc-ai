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
import { ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY } from "@cocalc/util/ai/external-credential-profiles";
import {
  HARNESS_CREDENTIAL_SELECTION_EVENT,
  readHarnessCredentialSelection,
} from "./harness-credential-selection";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export function claudePaymentLabel(mode: string | undefined): string {
  return mode === "account-subscription"
    ? "Claude subscription"
    : mode === "account-api-key"
      ? "Account API key"
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
  if (!projectId || !threadKey) return undefined;
  return claudePaymentLabel(
    readHarnessCredentialSelection({ accountId, projectId, threadKey })?.mode,
  );
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
  const [credential, setCredential] = useState<ExternalCredentialInfo>();
  const [loading, setLoading] = useState(false);
  const subscription = mode === "account-subscription";
  const label = claudePaymentLabel(mode);
  useEffect(() => {
    if (!open || !credentialId) return;
    let active = true;
    setLoading(true);
    void webapp_client.conat_client.hub.system
      .listExternalCredentials({ provider: "anthropic", scope: "account" })
      .then((rows) => {
        if (active)
          setCredential(
            rows.find(({ id, revoked }) => id === credentialId && !revoked),
          );
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, credentialId]);
  const identity =
    credential?.metadata?.[ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY];
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
            {identity && <div>{identity}</div>}
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
                      {window.name}: {window.usedPercent}% used
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
        aria-label={`${label}: payment settings`}
        aria-haspopup="dialog"
      >
        {label}
      </Button>
    </Popover>
  );
}
