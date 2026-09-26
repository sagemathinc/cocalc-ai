import { Button, Popover, Progress, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ClaudeSubscriptionUsage } from "@cocalc/util/ai/claude-usage";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY } from "@cocalc/util/ai/external-credential-profiles";
import {
  HARNESS_CREDENTIAL_SELECTION_EVENT,
  readHarnessCredentialSelection,
} from "./harness-credential-selection";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

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
      projectId={projectId}
      credentialId={credentialId}
      mode={credential?.mode ?? "project-secret"}
      onConfigure={onConfigure}
    />
  );
}

function PaymentStatus({
  projectId,
  credentialId,
  mode,
  onConfigure,
}: {
  projectId: string;
  credentialId?: string;
  mode: string;
  onConfigure: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [usage, setUsage] = useState<ClaudeSubscriptionUsage>();
  const [credential, setCredential] = useState<ExternalCredentialInfo>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const subscription = mode === "account-subscription";
  const label = subscription
    ? "Claude subscription"
    : mode === "account-api-key"
      ? "Account API key"
      : "Project API key";
  useEffect(() => {
    if (!open) return;
    let active = true;
    if (credentialId) {
      void webapp_client.conat_client.hub.system
        .listExternalCredentials({ provider: "anthropic", scope: "account" })
        .then((rows) => {
          if (active)
            setCredential(
              rows.find(({ id, revoked }) => id === credentialId && !revoked),
            );
        })
        .catch(() => {});
    }
    if (subscription && credentialId) {
      setLoading(true);
      setError("");
      void webapp_client.conat_client.hub.projects
        .getClaudeSubscriptionUsage({
          project_id: projectId,
          credential_id: credentialId,
        })
        .then((value) => {
          if (active) setUsage(value);
        })
        .catch(() => {
          if (active)
            setError("Usage unavailable. Try again after your next turn.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [open, projectId, credentialId, subscription]);
  const identity =
    credential?.metadata?.[ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY];
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
                  {loading
                    ? "Loading subscription usage..."
                    : error ||
                      (!usage?.available
                        ? "Usage not reported by Claude."
                        : "")}
                </div>
                {!loading &&
                  !error &&
                  usage?.windows.map((window) => (
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
                      {window.resetsAt && (
                        <Typography.Text type="secondary">
                          Resets {new Date(window.resetsAt).toLocaleString()}
                        </Typography.Text>
                      )}
                    </div>
                  ))}
                {usage && !error && (
                  <div>
                    <Typography.Text type="secondary">
                      Updated {new Date(usage.fetchedAt).toLocaleTimeString()}
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
