import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CODEX_CREDENTIALS_LABELS } from "./codex-labels";
import {
  Alert,
  Button,
  Collapse,
  Input,
  message,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { useAsyncEffect, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import {
  clearCachedCodexModelCatalog,
  getChatGptAccountInfo,
  getCodexSubscriptionConnection,
  getLiveCodexUsageStatus,
} from "@cocalc/frontend/account/codex-usage";
import { getCodexSubscriptionDisplayName } from "@cocalc/frontend/chat/codex-subscription-label";
import { Icon, Loading } from "@cocalc/frontend/components";
import Password from "@cocalc/frontend/components/password";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import {
  UsageWindowMeters,
  type UsageWindowMeter,
} from "@cocalc/frontend/account/usage-window-meters";
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { formatCodexErrorForDisplay } from "@cocalc/frontend/chat/codex-error-presentation";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type {
  CodexPaymentSourceInfo,
  CodexUsageStatusInfo,
  ExternalCredentialInfo,
} from "@cocalc/conat/hub/api/system";

const { Text } = Typography;
const SUBSCRIPTION_AUTH_PANEL_KEY = "subscription-auth";

const recommendedCardStyle: CSSProperties = {
  border: `1px solid ${UI_COLORS.border}`,
  borderRadius: 8,
  background: UI_COLORS.surface,
  padding: 16,
};

const deviceAuthCodeStyle: CSSProperties = {
  border: `1px solid ${UI_COLORS.border}`,
  borderRadius: 8,
  background: UI_COLORS.inset,
  padding: 12,
};

function sourceLabel(source: CodexPaymentSourceInfo["source"]): string {
  if (lite) {
    if (source === "subscription") return "ChatGPT Plan";
    if (
      source === "project-api-key" ||
      source === "account-api-key" ||
      source === "site-api-key"
    ) {
      return "OpenAI API key";
    }
    if (source === "shared-home") return "Local Codex auth";
    return "Not configured";
  }
  switch (source) {
    case "subscription":
      return "ChatGPT plan";
    case "project-api-key":
      return "Project API key";
    case "account-api-key":
      return "Account API key";
    case "site-api-key":
      return "CoCalc Membership";
    case "shared-home":
      return "Shared home (~/.codex)";
    default:
      return "None";
  }
}

function parseDeviceAuthUserCode(output?: string): string | undefined {
  if (!output) return undefined;
  const explicit = output.match(
    /one-time code[^\n]*\n\s*([A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6}){1,2})\b/i,
  );
  if (explicit?.[1]) return explicit[1];
  const fallback = output.match(/\b[A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6}){1,2}\b/g);
  return fallback?.[fallback.length - 1];
}

function parseDeviceAuthVerificationUrl(output?: string): string | undefined {
  return output?.match(/https?:\/\/[^\s)]+/)?.[0];
}

function getCodexRateLimit(status?: CodexUsageStatusInfo): any {
  const rateLimits = status?.rateLimits as any;
  return (
    rateLimits?.rateLimitsByLimitId?.codex ??
    rateLimits?.rate_limits_by_limit_id?.codex ??
    rateLimits?.rateLimits ??
    rateLimits?.rate_limits
  );
}

function formatPlanType(planType?: string): string | undefined {
  const normalized = `${planType ?? ""}`.trim();
  if (!normalized) return undefined;
  return normalized
    .split(/[_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getResetDate(seconds?: number | null): Date | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return undefined;
  }
  return new Date(seconds * 1000);
}

function getRemainingPercent(limit?: any): number | undefined {
  const value = limit?.usedPercent ?? limit?.used_percent;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(100 - value)))
    : undefined;
}

function getWindowDurationMins(limit?: any): number | undefined {
  const value = limit?.windowDurationMins ?? limit?.window_duration_mins;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function formatWindowLabel(limit: any, fallback: string): string {
  const mins = getWindowDurationMins(limit);
  if (!mins) return fallback;
  if (mins % (24 * 60) === 0) {
    const days = mins / (24 * 60);
    return `${days}-day limit`;
  }
  if (mins % 60 === 0) {
    const hours = mins / 60;
    return `${hours}-hour limit`;
  }
  return `${mins}-minute limit`;
}

function getUsageWindows(rateLimit: any): UsageWindowMeter[] {
  return (["primary", "secondary"] as const)
    .map((key) => {
      const limit = rateLimit?.[key];
      if (!limit) return undefined;
      return {
        key,
        label: formatWindowLabel(
          limit,
          key === "primary" ? "Short window" : "Long window",
        ),
        remainingPercent: getRemainingPercent(limit),
        resetAt: getResetDate(limit?.resetsAt ?? limit?.resets_at),
      };
    })
    .filter((window) => !!window);
}

export function CodexUsageMeters({
  status,
  compact = false,
  stale = false,
  updating = false,
}: {
  status?: CodexUsageStatusInfo;
  compact?: boolean;
  stale?: boolean;
  updating?: boolean;
}): React.JSX.Element | null {
  const usageWindows = getUsageWindows(getCodexRateLimit(status));
  return (
    <UsageWindowMeters
      compact={compact}
      stale={stale}
      statusLabel="Codex usage"
      updating={updating}
      windows={usageWindows}
    />
  );
}

function MembershipUsageMeters({
  paymentSource,
}: {
  paymentSource?: CodexPaymentSourceInfo;
}) {
  const status = paymentSource?.siteFundedCodex?.status?.account;
  if (!status) {
    return (
      <Text type="secondary">
        CoCalc Membership usage is not available for this account.
      </Text>
    );
  }
  const windows = [
    {
      key: "5h",
      label: "5-hour limit",
      limit: status.limit5hMicrousd,
      remaining: status.remaining5hMicrousd,
      resetAt: status.reset5hAt,
    },
    {
      key: "7d",
      label: "7-day limit",
      limit: status.limit7dMicrousd,
      remaining: status.remaining7dMicrousd,
      resetAt: status.reset7dAt,
    },
  ]
    .filter(
      ({ limit, remaining }) =>
        typeof limit === "number" &&
        Number.isFinite(limit) &&
        limit > 0 &&
        typeof remaining === "number" &&
        Number.isFinite(remaining),
    )
    .map(({ key, label, limit = 0, remaining = 0, resetAt }) => ({
      key,
      label,
      remainingPercent: Math.max(
        0,
        Math.min(100, Math.round((remaining / limit) * 100)),
      ),
      resetAt: resetAt ? new Date(resetAt) : undefined,
    }));
  return (
    <UsageWindowMeters
      windows={windows}
      statusLabel="CoCalc Membership usage"
    />
  );
}

function formatCodexUsageReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  if (
    reason.includes("account/rateLimits/read") ||
    reason.includes("authentication required to read rate limits")
  ) {
    return "Codex could not authenticate the stored ChatGPT sign-in. Sign in again, then retry the usage check.";
  }
  return formatCodexErrorForDisplay(reason, lite);
}

export function CodexCredentialsPanel(props: CodexCredentialsPanelProps = {}) {
  return <CodexCredentialsPanelBody {...props} />;
}

export interface CodexCredentialsPanelProps {
  embedded?: boolean;
  defaultProjectId?: string;
  hidePanelChrome?: boolean;
  onPaymentSourceChanged?: () => void;
}

type DeviceAuthState =
  | "pending"
  | "syncing"
  | "completed"
  | "failed"
  | "canceled";

type DeviceAuthStatus = {
  id: string;
  projectId: string;
  accountId: string;
  codexHome: string;
  state: DeviceAuthState;
  verificationUrl?: string;
  userCode?: string;
  output: string;
  startedAt: number;
  updatedAt: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  syncedToRegistry?: boolean;
  syncError?: string;
  credentialId?: string;
  create?: boolean;
};

function credentialLastUsed(row: ExternalCredentialInfo): number {
  const value = row.last_used ? new Date(row.last_used).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

export function sortCredentialIdsByLastUsed(
  rows: ExternalCredentialInfo[],
): string[] {
  return [...rows]
    .sort((a, b) => {
      const byLastUsed = credentialLastUsed(b) - credentialLastUsed(a);
      if (byLastUsed !== 0) return byLastUsed;
      return `${a.id}`.localeCompare(`${b.id}`);
    })
    .map(({ id }) => id);
}

export function reconcileCredentialOrder(
  order: string[],
  rows: ExternalCredentialInfo[],
): string[] {
  const currentIds = new Set(rows.map(({ id }) => id));
  const next = order.filter((id) => currentIds.has(id));
  const orderedIds = new Set(next);
  for (const id of sortCredentialIdsByLastUsed(rows)) {
    if (!orderedIds.has(id)) next.push(id);
  }
  return next;
}

export function scrollCodexCredentialsModalToTop(
  root: HTMLElement | null,
): void {
  const modalBody = root?.closest<HTMLElement>(".ant-modal-body");
  modalBody?.scrollTo({ top: 0, behavior: "auto" });
}

const DEVICE_AUTH_ALERT_TYPE: Record<
  DeviceAuthState,
  "info" | "success" | "error" | "warning"
> = {
  pending: "info",
  syncing: "info",
  completed: "success",
  failed: "error",
  canceled: "warning",
};

function CodexCredentialsPanelBody({
  embedded = false,
  defaultProjectId = "",
  hidePanelChrome = false,
  onPaymentSourceChanged,
}: CodexCredentialsPanelProps = {}) {
  const accountId = useTypedRedux("account", "account_id");
  const projectMap = useTypedRedux("projects", "project_map");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [usageRefreshToken, setUsageRefreshToken] = useState<number>(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    defaultProjectId ?? "",
  );
  const [paymentSource, setPaymentSource] = useState<
    CodexPaymentSourceInfo | undefined
  >(undefined);
  const [codexUsageStatus, setCodexUsageStatus] = useState<
    CodexUsageStatusInfo | undefined
  >(undefined);
  const [codexUsageCredentialId, setCodexUsageCredentialId] = useState("");
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [usageSource, setUsageSource] = useState("");
  const [apiKeyStatus, setApiKeyStatus] = useState<any>(undefined);
  const [credentials, setCredentials] = useState<ExternalCredentialInfo[]>([]);
  const [credentialOrder, setCredentialOrder] = useState<string[]>([]);
  const [revokingId, setRevokingId] = useState<string>("");
  const [savingLabelId, setSavingLabelId] = useState<string>("");
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [accountApiKey, setAccountApiKey] = useState<string>("");
  const [projectApiKey, setProjectApiKey] = useState<string>("");
  const [savingScope, setSavingScope] = useState<"" | "account" | "project">(
    "",
  );
  const [deletingScope, setDeletingScope] = useState<
    "" | "account" | "project"
  >("");
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthStatus | null>(null);
  const [deviceAuthError, setDeviceAuthError] = useState<string>("");
  const [deviceAuthActionPending, setDeviceAuthActionPending] =
    useState<boolean>(false);
  const [credentialMutationTarget, setCredentialMutationTarget] = useState<{
    credentialId?: string;
    create: boolean;
  }>();
  const [openCredentialPanelKeys, setOpenCredentialPanelKeys] = useState<
    string[]
  >([]);
  const [authFileUploadPending, setAuthFileUploadPending] =
    useState<boolean>(false);
  const [uploadedAuthFileStatus, setUploadedAuthFileStatus] = useState<{
    bytes: number;
    uploadedAt: number;
  } | null>(null);
  const authFileInputRef = useRef<HTMLInputElement | null>(null);
  const panelRootRef = useRef<HTMLDivElement | null>(null);
  const subscriptionCredentialsOpenRef = useRef(false);
  const previousProjectKeyRef = useRef(selectedProjectId.trim());
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  const refresh = useCallback(() => {
    setRefreshToken((x) => x + 1);
    setUsageRefreshToken((x) => x + 1);
  }, []);
  const refreshUsage = useCallback(() => {
    setUsageRefreshToken((x) => x + 1);
  }, []);
  const refreshAfterPaymentSourceChange = useCallback(() => {
    clearCachedCodexModelCatalog({ accountId });
    refresh();
    onPaymentSourceChanged?.();
  }, [accountId, onPaymentSourceChanged, refresh]);
  const deviceAuthPending =
    deviceAuthActionPending || deviceAuth?.state === "pending";
  const openSubscriptionAuthPanel = useCallback(() => {
    setOpenCredentialPanelKeys((keys) =>
      keys.includes(SUBSCRIPTION_AUTH_PANEL_KEY)
        ? keys
        : [...keys, SUBSCRIPTION_AUTH_PANEL_KEY],
    );
  }, []);
  const handleCredentialPanelChange = useCallback(
    (key: string | string[]) => {
      let nextKeys = Array.isArray(key) ? key : [key];
      if (
        !embedded &&
        deviceAuthPending &&
        !nextKeys.includes(SUBSCRIPTION_AUTH_PANEL_KEY)
      ) {
        nextKeys = [SUBSCRIPTION_AUTH_PANEL_KEY, ...nextKeys];
      }
      const credentialsOpen = nextKeys.includes("credentials");
      if (credentialsOpen && !subscriptionCredentialsOpenRef.current) {
        setCredentialOrder(sortCredentialIdsByLastUsed(credentials));
      }
      subscriptionCredentialsOpenRef.current = credentialsOpen;
      setOpenCredentialPanelKeys(nextKeys);
    },
    [credentials, deviceAuthPending, embedded],
  );

  const recentProjectId = useMemo(() => {
    if (!projectMap) return "";
    try {
      const projects = (projectMap as any).valueSeq().toJS() as any[];
      if (!projects.length) return "";
      projects.sort((a, b) => (b?.last_edited ?? 0) - (a?.last_edited ?? 0));
      return projects[0]?.project_id ?? "";
    } catch {
      return "";
    }
  }, [projectMap]);

  const authProjectId = selectedProjectId.trim() || recentProjectId;

  useEffect(() => {
    setSelectedProjectId(defaultProjectId ?? "");
  }, [defaultProjectId]);

  useAsyncEffect(
    async (isMounted) => {
      const projectKey = selectedProjectId.trim();
      const projectChanged = previousProjectKeyRef.current !== projectKey;
      previousProjectKeyRef.current = projectKey;
      if (projectChanged) {
        setPaymentSource(undefined);
        setCredentials([]);
        setApiKeyStatus(undefined);
        setCodexUsageStatus(undefined);
        setCodexUsageCredentialId("");
        setDeviceAuth(null);
        setDeviceAuthError("");
        setUploadedAuthFileStatus(null);
      }
      setLoading(true);
      setError("");
      try {
        const project_id = projectKey || undefined;
        let payment: CodexPaymentSourceInfo;
        let list: ExternalCredentialInfo[] = [];
        let keyStatus: any = {};

        if (lite) {
          payment =
            await webapp_client.conat_client.hub.system.getCodexPaymentSource({
              project_id,
            });
        } else {
          const systemApi: any = webapp_client.conat_client.hub.system as any;
          const result = await Promise.all([
            webapp_client.conat_client.hub.system.getCodexPaymentSource({
              project_id,
            }),
            webapp_client.conat_client.hub.system.listExternalCredentials({
              provider: "openai",
              kind: "codex-subscription-auth-json",
              scope: "account",
            }),
            systemApi.getOpenAiApiKeyStatus({
              project_id,
            }),
          ]);
          payment = result[0] as CodexPaymentSourceInfo;
          list = (result[1] as ExternalCredentialInfo[]) ?? [];
          keyStatus = result[2] ?? {};
        }
        if (!isMounted()) return;
        setPaymentSource(payment as CodexPaymentSourceInfo);
        setCredentials(list);
        setCredentialOrder((order) => reconcileCredentialOrder(order, list));
        setApiKeyStatus(keyStatus ?? {});
      } catch (err) {
        if (!isMounted()) return;
        setError(`${err}`);
      } finally {
        if (isMounted()) setLoading(false);
      }
    },
    [refreshToken, selectedProjectId],
  );

  useAsyncEffect(
    async (isMounted) => {
      if (!usageSource.startsWith("subscription:")) {
        setCodexUsageLoading(false);
        return;
      }
      if (!paymentSource) return;
      if (!authProjectId && !lite) {
        const credentialId = usageSource.slice("subscription:".length);
        setCodexUsageStatus({
          available: false,
          checkedAt: new Date().toISOString(),
          paymentSource,
          reason:
            "Open a project before checking live ChatGPT Codex usage in CoCalc.",
        });
        setCodexUsageCredentialId(credentialId);
        setCodexUsageLoading(false);
        return;
      }
      setCodexUsageLoading(true);
      const credentialId = usageSource.slice("subscription:".length);
      try {
        const result = await getLiveCodexUsageStatus({
          projectId: authProjectId || undefined,
          credentialId: credentialId || undefined,
        });
        if (!isMounted()) return;
        setCodexUsageStatus(result as CodexUsageStatusInfo);
        setCodexUsageCredentialId(credentialId);
      } catch (err) {
        if (!isMounted()) return;
        setCodexUsageStatus({
          available: false,
          checkedAt: new Date().toISOString(),
          paymentSource,
          project_id: authProjectId || undefined,
          reason: formatCodexUsageReason(getErrorMessage(err)),
        });
        setCodexUsageCredentialId(credentialId);
      } finally {
        if (isMounted()) setCodexUsageLoading(false);
      }
    },
    [authProjectId, usageRefreshToken, usageSource],
  );

  const usageSourceOptions = useMemo(() => {
    const subscriptions = paymentSource?.subscriptions ?? [];
    return [
      ...subscriptions.map((credential) => ({
        value: `subscription:${credential.id}`,
        label: getCodexSubscriptionDisplayName(credential, subscriptions),
      })),
      ...(subscriptions.length === 0 &&
      (paymentSource?.hasSubscription ||
        paymentSource?.source === "subscription")
        ? [{ value: "subscription:", label: "ChatGPT" }]
        : []),
      ...(paymentSource?.hasSiteApiKey
        ? [{ value: "site-api-key", label: "CoCalc Membership" }]
        : []),
      ...(paymentSource?.hasProjectApiKey
        ? [{ value: "project-api-key", label: "Project OpenAI API key" }]
        : []),
      ...(paymentSource?.hasAccountApiKey
        ? [{ value: "account-api-key", label: "Account OpenAI API key" }]
        : []),
    ];
  }, [paymentSource]);

  useEffect(() => {
    if (!usageSourceOptions.length) {
      setUsageSource("");
      return;
    }
    if (usageSourceOptions.some(({ value }) => value === usageSource)) return;
    const selectedCredential = paymentSource?.credentialId;
    const exact = selectedCredential
      ? `subscription:${selectedCredential}`
      : undefined;
    setUsageSource(
      usageSourceOptions.find(({ value }) => value === exact)?.value ??
        usageSourceOptions[0].value,
    );
  }, [paymentSource?.credentialId, usageSource, usageSourceOptions]);

  const startDeviceAuth = useCallback(
    async (credentialId?: string, create = false) => {
      if (!embedded) openSubscriptionAuthPanel();
      if (!authProjectId) {
        setDeviceAuthError(
          "No project available. Create or open a project, then retry.",
        );
        return;
      }
      setDeviceAuthActionPending(true);
      setDeviceAuthError("");
      requestAnimationFrame(() =>
        scrollCodexCredentialsModalToTop(panelRootRef.current),
      );
      try {
        const subscriptions = paymentSource?.subscriptions ?? [];
        const targetCredentialId = create
          ? undefined
          : (credentialId ??
            paymentSource?.credentialId ??
            (subscriptions.length === 1 ? subscriptions[0].id : undefined));
        const targetCreate =
          create || (!targetCredentialId && !subscriptions.length);
        if (!targetCreate && !targetCredentialId) {
          throw new Error(
            "Choose the ChatGPT subscription to reconnect, or add a new subscription.",
          );
        }
        const capability =
          await webapp_client.conat_client.hub.projects.getCodexCredentialSelectionCapability(
            { project_id: authProjectId },
          );
        if (
          (capability?.version ?? 0) < 2 ||
          capability?.credentialLifecycle !== true
        ) {
          throw new Error(
            "This project host must be updated before ChatGPT subscriptions can be added or reconnected.",
          );
        }
        setCredentialMutationTarget({
          credentialId: targetCredentialId,
          create: targetCreate,
        });
        const status =
          await webapp_client.conat_client.hub.projects.codexDeviceAuthStartV2({
            project_id: authProjectId,
            ...(targetCredentialId
              ? { credential_id: targetCredentialId }
              : { create: true }),
          });
        setDeviceAuth(status as DeviceAuthStatus);
        refresh();
      } catch (err) {
        const error = err instanceof Error ? err.message : `${err}`;
        setDeviceAuthError(
          /\b(?:timed? out|timeout)\b/i.test(error)
            ? "Starting ChatGPT sign-in timed out. Codex may still be starting in the selected project. Wait a few seconds, then click Sign in again; CoCalc will not retry automatically because that could start a duplicate login."
            : error,
        );
      } finally {
        setDeviceAuthActionPending(false);
      }
    },
    [
      authProjectId,
      embedded,
      openSubscriptionAuthPanel,
      paymentSource?.credentialId,
      paymentSource?.subscriptions,
      refresh,
    ],
  );

  const saveCredentialLabel = useCallback(
    async (row: ExternalCredentialInfo, value: string) => {
      const label = value.trim();
      if (label === `${row.metadata?.label ?? ""}`.trim()) return;
      setSavingLabelId(row.id);
      try {
        const result =
          await webapp_client.conat_client.hub.system.updateCodexSubscriptionLabel(
            { id: row.id, label: label || undefined },
          );
        if (!result.updated) {
          throw Error("ChatGPT subscription is no longer available");
        }
        setCredentials((items) =>
          items.map((item) => {
            if (item.id !== row.id) return item;
            const metadata = { ...item.metadata };
            if (label) metadata.label = label;
            else delete metadata.label;
            return { ...item, metadata };
          }),
        );
        setLabelDrafts((drafts) => {
          const next = { ...drafts };
          delete next[row.id];
          return next;
        });
        refreshAfterPaymentSourceChange();
      } catch (err) {
        setError(`${err}`);
        setLabelDrafts((drafts) => ({
          ...drafts,
          [row.id]: `${row.metadata?.label ?? ""}`,
        }));
      } finally {
        setSavingLabelId("");
      }
    },
    [refreshAfterPaymentSourceChange],
  );

  const columns = useMemo(
    () => [
      {
        title: "Credential",
        key: "credential",
        render: (_: any, row: ExternalCredentialInfo) => {
          const subscriptions = paymentSource?.subscriptions ?? [];
          const subscription = subscriptions.find(({ id }) => id === row.id);
          const displayName = subscription
            ? getCodexSubscriptionDisplayName(subscription, subscriptions)
            : row.metadata?.label || "ChatGPT";
          return (
            <Space orientation="vertical" size={0}>
              <Text strong>{displayName}</Text>
              {row.metadata?.email ? (
                <Text type="secondary">{row.metadata.email}</Text>
              ) : null}
              <Text type="secondary">
                {formatPlanType(row.metadata?.plan_type) ??
                  row.metadata?.provider_account_id?.slice?.(0, 12) ??
                  "Connected plan"}
                {row.metadata?.cocalc_default ? " (default)" : ""}
              </Text>
              <Input
                size="small"
                aria-label={`Label for ${row.metadata?.email || "ChatGPT subscription"}`}
                placeholder="Optional label"
                maxLength={60}
                value={labelDrafts[row.id] ?? row.metadata?.label ?? ""}
                disabled={savingLabelId === row.id}
                onChange={(event) =>
                  setLabelDrafts((drafts) => ({
                    ...drafts,
                    [row.id]: event.target.value,
                  }))
                }
                onBlur={(event) =>
                  void saveCredentialLabel(row, event.target.value)
                }
                onPressEnter={(event) => event.currentTarget.blur()}
                style={{ width: 180, marginTop: 4 }}
              />
            </Space>
          );
        },
      },
      {
        title: "Updated",
        key: "updated",
        render: (_: any, row: ExternalCredentialInfo) => (
          <TimeAgo date={row.updated} />
        ),
      },
      {
        title: "Last used",
        key: "last_used",
        render: (_: any, row: ExternalCredentialInfo) =>
          row.last_used ? (
            <TimeAgo date={row.last_used} />
          ) : (
            <Text type="secondary">Never</Text>
          ),
      },
      {
        title: "Action",
        key: "action",
        render: (_: any, row: ExternalCredentialInfo) => (
          <Space>
            <Button
              size="small"
              onClick={() => void startDeviceAuth(row.id)}
              disabled={deviceAuth?.state === "pending"}
            >
              Reconnect
            </Button>
            <Popconfirm
              title="Delete external credential?"
              description="This revokes it for future Codex turns."
              okText="Delete"
              okButtonProps={{ danger: true }}
              onConfirm={async () => {
                setRevokingId(row.id);
                try {
                  const completed = await runFreshAuthAction(async () => {
                    await webapp_client.conat_client.hub.system.revokeExternalCredential(
                      {
                        id: row.id,
                        browser_id: webapp_client.browser_id,
                      },
                    );
                  });
                  if (!completed) {
                    return;
                  }
                  refreshAfterPaymentSourceChange();
                } catch (err) {
                  setError(`${err}`);
                } finally {
                  setRevokingId("");
                }
              }}
            >
              <Button
                size="small"
                danger
                loading={revokingId === row.id}
                disabled={!!row.revoked}
              >
                Delete
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [
      deviceAuth?.state,
      refreshAfterPaymentSourceChange,
      revokingId,
      labelDrafts,
      paymentSource?.subscriptions,
      saveCredentialLabel,
      savingLabelId,
      startDeviceAuth,
    ],
  );

  const orderedCredentials = useMemo(() => {
    const byId = new Map(credentials.map((row) => [row.id, row]));
    return reconcileCredentialOrder(credentialOrder, credentials)
      .map((id) => byId.get(id))
      .filter((row): row is ExternalCredentialInfo => row != null);
  }, [credentialOrder, credentials]);

  const getErrorMessage = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    return `${err}`;
  };

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement("textarea");
        el.value = text;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.focus();
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      void message.success(`${label} copied`);
    } catch (err) {
      void message.error(
        `Unable to copy ${label.toLowerCase()}: ${getErrorMessage(err)}`,
      );
    }
  };

  const refreshDeviceAuth = async (id?: string) => {
    if (!authProjectId) return;
    const authId = id ?? deviceAuth?.id;
    if (!authId) return;
    try {
      const status =
        await webapp_client.conat_client.hub.projects.codexDeviceAuthStatus({
          project_id: authProjectId,
          id: authId,
        });
      setDeviceAuth(status as DeviceAuthStatus);
      if ((status as DeviceAuthStatus).state === "completed") {
        refreshAfterPaymentSourceChange();
      }
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    }
  };

  const cancelDeviceAuth = async () => {
    if (!authProjectId || !deviceAuth?.id) return;
    setDeviceAuthActionPending(true);
    setDeviceAuthError("");
    try {
      await webapp_client.conat_client.hub.projects.codexDeviceAuthCancel({
        project_id: authProjectId,
        id: deviceAuth.id,
      });
      await refreshDeviceAuth(deviceAuth.id);
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    } finally {
      setDeviceAuthActionPending(false);
    }
  };

  const renderDeviceAuthLogin = () => {
    if (!deviceAuth && !deviceAuthError && !deviceAuthActionPending) {
      return null;
    }
    const userCode =
      deviceAuth?.userCode ?? parseDeviceAuthUserCode(deviceAuth?.output);
    const verificationUrl =
      deviceAuth?.verificationUrl ??
      parseDeviceAuthVerificationUrl(deviceAuth?.output);
    return (
      <Space orientation="vertical" size={8} style={{ width: "100%" }}>
        {deviceAuthError ? (
          <Alert type="error" showIcon title={deviceAuthError} />
        ) : null}
        {!deviceAuth && deviceAuthActionPending ? (
          <Alert
            type="info"
            showIcon
            title="Getting your one-time sign-in code..."
            description="This usually takes a few seconds. Keep this dialog open; the code and link will appear here automatically."
          />
        ) : null}
        {deviceAuth ? (
          <Alert
            type={DEVICE_AUTH_ALERT_TYPE[deviceAuth.state]}
            showIcon
            title={
              deviceAuth.state === "pending"
                ? "Finish signing in with ChatGPT"
                : deviceAuth.state === "syncing"
                  ? "Saving ChatGPT sign-in"
                  : deviceAuth.state === "completed"
                    ? "Codex is connected"
                    : `Codex sign-in ${deviceAuth.state}`
            }
            description={
              deviceAuth.state === "pending"
                ? "Copy the code, open the link, and sign in. CoCalc will detect completion automatically."
                : deviceAuth.state === "syncing"
                  ? "ChatGPT accepted the sign-in. CoCalc is saving it so Codex can use it from this and future projects."
                  : deviceAuth.error
                    ? deviceAuth.error
                    : deviceAuth.syncError
                      ? `Verification failed: ${deviceAuth.syncError}. Please run the ChatGPT sign-in again.`
                      : undefined
            }
          />
        ) : null}
        {deviceAuth?.state === "pending" && !userCode && !verificationUrl ? (
          <Alert
            type="info"
            showIcon
            title="Waiting for Codex sign-in instructions..."
            description="The one-time code and link will appear here as soon as Codex returns them."
          />
        ) : null}
        {userCode && deviceAuth?.state === "pending" ? (
          <div
            style={{
              ...deviceAuthCodeStyle,
              cursor: "pointer",
            }}
            role="button"
            tabIndex={0}
            onClick={() => void copyText(userCode, "Device code")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void copyText(userCode, "Device code");
              }
            }}
          >
            <Text type="secondary">1. Copy this one-time code</Text>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <Text
                style={{
                  fontSize: 28,
                  lineHeight: "34px",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  whiteSpace: "nowrap",
                }}
              >
                {userCode}
              </Text>
              <Button
                onClick={(event) => {
                  event.stopPropagation();
                  void copyText(userCode, "Device code");
                }}
              >
                Copy code
              </Button>
            </div>
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">
                Device codes are a common phishing target. Never share this
                code.
              </Text>
            </div>
          </div>
        ) : null}
        {verificationUrl && deviceAuth?.state === "pending" ? (
          <div style={deviceAuthCodeStyle}>
            <Text type="secondary">
              2.{" "}
              <a href={verificationUrl} target="_blank" rel="noreferrer">
                Open this link
              </a>{" "}
              in your browser, sign in to your account, and paste the code.
            </Text>
            <div style={{ marginTop: 8 }}>
              <Space wrap>
                <Button
                  type="primary"
                  href={verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open
                </Button>
                <Button
                  onClick={() =>
                    void copyText(verificationUrl, "Verification URL")
                  }
                >
                  Copy URL
                </Button>
              </Space>
            </div>
          </div>
        ) : null}
        {deviceAuth?.id ? (
          <Space wrap>
            <Button
              onClick={() => void refreshDeviceAuth()}
              disabled={!authProjectId || deviceAuthActionPending}
            >
              Refresh status
            </Button>
            <Button
              danger
              onClick={() => void cancelDeviceAuth()}
              loading={deviceAuthActionPending}
              disabled={
                !authProjectId ||
                deviceAuthActionPending ||
                deviceAuth.state !== "pending"
              }
            >
              Cancel
            </Button>
          </Space>
        ) : null}
      </Space>
    );
  };

  const renderCodexUsageStatusDetails = () => {
    if (!usageSourceOptions.length) return null;
    const selectedCredentialId = usageSource.slice("subscription:".length);
    const selectedUsageStatus =
      selectedCredentialId === codexUsageCredentialId
        ? codexUsageStatus
        : undefined;
    const rateLimit = getCodexRateLimit(selectedUsageStatus);
    const planType =
      formatPlanType(getChatGptAccountInfo(selectedUsageStatus)?.planType) ??
      formatPlanType(rateLimit?.planType ?? rateLimit?.plan_type);
    const reason = formatCodexUsageReason(selectedUsageStatus?.reason);
    return (
      <Space orientation="vertical" size={6} style={{ width: "100%" }}>
        <Text strong>Codex usage</Text>
        <Select
          aria-label="Codex usage payment source"
          value={usageSource}
          options={usageSourceOptions}
          onChange={setUsageSource}
          style={{ width: "100%", maxWidth: 360 }}
        />
        {usageSource === "site-api-key" ? (
          <MembershipUsageMeters paymentSource={paymentSource} />
        ) : usageSource.endsWith("-api-key") ? (
          <Text type="secondary">
            OpenAI does not provide a subscription-style remaining usage view
            for API keys. Review API usage and billing in your OpenAI account.
          </Text>
        ) : codexUsageLoading && !selectedUsageStatus ? (
          <Text type="secondary">Checking ChatGPT Codex usage...</Text>
        ) : !selectedUsageStatus ? (
          <Text type="secondary">Usage status has not been checked yet.</Text>
        ) : null}
        {usageSource.startsWith("subscription:") ? (
          <>
            <Space wrap>
              {planType ? <Tag color="green">{planType}</Tag> : null}
            </Space>
            <CodexUsageMeters status={selectedUsageStatus} />
            {reason ? <Text type="secondary">{reason}</Text> : null}
            <Button
              size="small"
              onClick={refreshUsage}
              loading={codexUsageLoading}
              disabled={codexUsageLoading}
              style={{ alignSelf: "flex-start" }}
            >
              Refresh usage
            </Button>
          </>
        ) : null}
      </Space>
    );
  };

  const uploadAuthFile = async (file: File) => {
    if (!authProjectId) {
      setDeviceAuthError(
        "No project available. Create or open a project, then retry.",
      );
      return;
    }
    setAuthFileUploadPending(true);
    setDeviceAuthError("");
    try {
      const content = await file.text();
      const subscriptions = paymentSource?.subscriptions ?? [];
      const targetCredentialId =
        credentialMutationTarget?.credentialId ??
        paymentSource?.credentialId ??
        (subscriptions.length === 1 ? subscriptions[0].id : undefined);
      const targetCreate =
        credentialMutationTarget?.create ??
        (!targetCredentialId && !subscriptions.length);
      if (!targetCreate && !targetCredentialId) {
        throw new Error(
          "Choose Reconnect on the target subscription, or choose Add, before uploading auth.json.",
        );
      }
      const capability =
        await webapp_client.conat_client.hub.projects.getCodexCredentialSelectionCapability(
          { project_id: authProjectId },
        );
      if (
        (capability?.version ?? 0) < 2 ||
        capability?.credentialLifecycle !== true
      ) {
        throw new Error(
          "This project host must be updated before a ChatGPT auth file can be uploaded.",
        );
      }
      const result =
        await webapp_client.conat_client.hub.projects.codexUploadAuthFileV2({
          project_id: authProjectId,
          filename: file.name,
          content,
          ...(targetCredentialId
            ? { credential_id: targetCredentialId }
            : { create: true }),
        });
      setUploadedAuthFileStatus({
        bytes: result.bytes,
        uploadedAt: Date.now(),
      });
      refreshAfterPaymentSourceChange();
      void message.success("Auth file uploaded successfully");
    } catch (err) {
      setDeviceAuthError(getErrorMessage(err));
    } finally {
      setAuthFileUploadPending(false);
      if (authFileInputRef.current) authFileInputRef.current.value = "";
    }
  };

  useEffect(() => {
    if (
      !authProjectId ||
      !deviceAuth?.id ||
      (deviceAuth.state !== "pending" && deviceAuth.state !== "syncing")
    ) {
      return;
    }
    const timer = setInterval(() => {
      void refreshDeviceAuth(deviceAuth.id);
    }, 1500);
    return () => clearInterval(timer);
  }, [authProjectId, deviceAuth?.id, deviceAuth?.state]);

  useEffect(() => {
    if (deviceAuthPending && !embedded) {
      openSubscriptionAuthPanel();
    }
  }, [deviceAuthPending, embedded, openSubscriptionAuthPanel]);

  const codexConnection = getCodexSubscriptionConnection(codexUsageStatus);
  const codexUsageAuthProblem = codexConnection.status === "needs-sign-in";
  const codexConnectionVerified = codexConnection.status === "connected";
  const codexConnectionChecking =
    codexUsageLoading && !codexUsageStatus && !codexUsageAuthProblem;
  const codexConnectionLabel = codexUsageAuthProblem
    ? "Sign-in needs refresh"
    : codexConnectionVerified
      ? "Connected"
      : codexConnectionChecking
        ? "Checking sign-in"
        : "Connection not verified";
  const codexConnectionTitle = codexUsageAuthProblem
    ? "Refresh your ChatGPT sign-in"
    : codexConnectionVerified
      ? "ChatGPT is connected"
      : codexConnectionChecking
        ? "Checking your ChatGPT sign-in"
        : "Could not verify your ChatGPT sign-in";

  const content = (
    <Space
      ref={panelRootRef}
      orientation="vertical"
      size="middle"
      style={{ width: "100%" }}
    >
      <div style={recommendedCardStyle}>
        <Space orientation="vertical" size={10} style={{ width: "100%" }}>
          {paymentSource?.source === "subscription" ? (
            <>
              <Space wrap>
                <Tag
                  color={
                    codexUsageAuthProblem
                      ? "orange"
                      : codexConnectionVerified
                        ? "green"
                        : "gold"
                  }
                >
                  {codexConnectionLabel}
                </Tag>
                <Text strong style={{ fontSize: 18 }}>
                  {codexConnectionTitle}
                </Text>
              </Space>
              <Text type="secondary">
                {codexUsageAuthProblem
                  ? "Your ChatGPT plan is selected for Codex, but the stored sign-in needs to be refreshed before Codex can use it."
                  : codexConnectionVerified
                    ? "CoCalc is using your ChatGPT subscription for Codex. Usage for each configured payment source is shown below."
                    : codexConnectionChecking
                      ? "CoCalc found a stored ChatGPT credential and is checking whether Codex can use it."
                      : "CoCalc found a stored ChatGPT credential, but the live check did not confirm that Codex can use it. Refresh usage or sign in again."}
              </Text>
              <Space wrap>
                <Button
                  type={codexUsageAuthProblem ? "primary" : undefined}
                  onClick={() => void startDeviceAuth()}
                  loading={deviceAuthActionPending}
                  disabled={deviceAuth?.state === "pending"}
                >
                  {deviceAuthActionPending
                    ? "Getting sign-in code..."
                    : "Sign in again with ChatGPT"}
                </Button>
                <Button
                  onClick={() => void startDeviceAuth(undefined, true)}
                  loading={deviceAuthActionPending}
                  disabled={deviceAuth?.state === "pending"}
                >
                  Add ChatGPT subscription
                </Button>
              </Space>
              {!authProjectId ? (
                <Text type="secondary">
                  Device sign-in needs a project to run Codex. Open or create a
                  project, then try again.
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <Space wrap>
                <Tag color="green">Recommended</Tag>
                <Text strong style={{ fontSize: 18 }}>
                  {CODEX_CREDENTIALS_LABELS.chatgpt}
                </Text>
              </Space>
              <Text type="secondary">
                Sign in once to use your ChatGPT Codex subscription in CoCalc.
                No API key is needed.
              </Text>
              <Space wrap>
                <Button
                  type="primary"
                  onClick={() => void startDeviceAuth()}
                  loading={deviceAuthActionPending}
                  disabled={deviceAuth?.state === "pending"}
                >
                  {deviceAuthActionPending
                    ? "Getting sign-in code..."
                    : "Sign in with ChatGPT"}
                </Button>
              </Space>
              {!authProjectId ? (
                <Text type="secondary">
                  Device sign-in needs a project to run Codex. Open or create a
                  project, then try again.
                </Text>
              ) : null}
            </>
          )}
        </Space>
      </div>
      {renderDeviceAuthLogin()}
      {loading && <Loading />}
      {!loading && error && <Alert type="error" title={error} />}
      {!loading && !error && embedded && paymentSource?.source === "none" && (
        <Text type="secondary">Codex is not connected yet.</Text>
      )}
      {!loading &&
        !error &&
        paymentSource &&
        (paymentSource.source === "none" && embedded ? null : (
          <Alert
            type={paymentSource.source === "none" ? "warning" : "info"}
            title={
              <Space>
                <span>Current Codex payment source:</span>
                <Tag
                  color={paymentSource.source === "none" ? "default" : "blue"}
                >
                  {sourceLabel(
                    paymentSource.source as CodexPaymentSourceInfo["source"],
                  )}
                </Tag>
              </Space>
            }
            description={
              lite ? (
                <Space
                  orientation="vertical"
                  size={6}
                  style={{ width: "100%" }}
                >
                  <Text type="secondary">
                    Codex will prefer your ChatGPT Plan. Use an OpenAI API key
                    only as a fallback.
                  </Text>
                  {renderCodexUsageStatusDetails()}
                </Space>
              ) : (
                <Space
                  orientation="vertical"
                  size={6}
                  style={{ width: "100%" }}
                >
                  <Text type="secondary">
                    Order: ChatGPT Plan, Project OpenAI API key, Account OpenAI
                    API key, then Site OpenAI API key.
                  </Text>
                  <Space wrap>
                    <Tag
                      color={
                        paymentSource.hasSubscription ? "green" : "default"
                      }
                    >
                      ChatGPT plan
                    </Tag>
                    <Tag
                      color={
                        paymentSource.hasProjectApiKey ? "green" : "default"
                      }
                    >
                      project key
                    </Tag>
                    <Tag
                      color={
                        paymentSource.hasAccountApiKey ? "green" : "default"
                      }
                    >
                      account key
                    </Tag>
                    <Tag
                      color={paymentSource.hasSiteApiKey ? "green" : "default"}
                    >
                      site key
                    </Tag>
                    <Tag>shared-home mode: {paymentSource.sharedHomeMode}</Tag>
                  </Space>
                  {renderCodexUsageStatusDetails()}
                </Space>
              )
            }
          />
        ))}
      <Collapse
        size="small"
        activeKey={openCredentialPanelKeys}
        onChange={handleCredentialPanelChange}
        items={[
          {
            key: SUBSCRIPTION_AUTH_PANEL_KEY,
            label: "Advanced ChatGPT sign-in options",
            children: (
              <Space orientation="vertical" size={8} style={{ width: "100%" }}>
                <Text type="secondary">
                  Use device login, or upload local{" "}
                  <Text code>~/.codex/auth.json</Text> as a fallback.
                </Text>
                {!authProjectId ? (
                  <Alert
                    type="warning"
                    showIcon
                    title="No project available"
                    description="Create or open a project, then retry."
                  />
                ) : (
                  <Text type="secondary">
                    Using project: <Text code>{authProjectId}</Text>
                    {!selectedProjectId.trim() ? " (most recently edited)" : ""}
                  </Text>
                )}
                <Space wrap>
                  <Button
                    type="primary"
                    onClick={() => void startDeviceAuth()}
                    loading={deviceAuthActionPending}
                    disabled={!authProjectId || deviceAuth?.state === "pending"}
                  >
                    Start device login
                  </Button>
                  <Button
                    onClick={() => void refreshDeviceAuth()}
                    disabled={
                      !authProjectId ||
                      !deviceAuth?.id ||
                      deviceAuthActionPending
                    }
                  >
                    Refresh status
                  </Button>
                  <Button
                    danger
                    onClick={() => void cancelDeviceAuth()}
                    loading={deviceAuthActionPending}
                    disabled={
                      !authProjectId ||
                      !deviceAuth?.id ||
                      deviceAuth?.state !== "pending"
                    }
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => authFileInputRef.current?.click()}
                    loading={authFileUploadPending}
                    disabled={!authProjectId || deviceAuthActionPending}
                  >
                    Upload local auth.json
                  </Button>
                </Space>
                <input
                  ref={authFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    if (file) {
                      void uploadAuthFile(file);
                    }
                  }}
                />
                {uploadedAuthFileStatus ? (
                  <Alert
                    type="success"
                    showIcon
                    title="Auth file uploaded"
                    description={`Saved ${uploadedAuthFileStatus.bytes} bytes to your CoCalc account credential registry.`}
                  />
                ) : null}
                {deviceAuthError ? (
                  <Text type="secondary">
                    Device login details are shown directly below the main Sign
                    in with ChatGPT button.
                  </Text>
                ) : null}
                {deviceAuth?.output ? (
                  <Collapse
                    size="small"
                    items={[
                      {
                        key: "raw-device-auth-output",
                        label: "Show raw Codex output",
                        children: (
                          <Input.TextArea
                            readOnly
                            value={deviceAuth.output}
                            autoSize={{ minRows: 3, maxRows: 10 }}
                          />
                        ),
                      },
                    ]}
                  />
                ) : null}
              </Space>
            ),
          },
          ...(lite
            ? []
            : [
                {
                  key: "api-keys",
                  label: CODEX_CREDENTIALS_LABELS.apiKeys,
                  children: (
                    <Space
                      orientation="vertical"
                      size="middle"
                      style={{ width: "100%" }}
                    >
                      <div style={{ maxWidth: 520 }}>
                        <div style={{ marginBottom: 6, fontWeight: 500 }}>
                          Project (optional)
                        </div>
                        <Space wrap style={{ width: "100%" }}>
                          <SelectProject
                            value={selectedProjectId}
                            onChange={(project_id) =>
                              setSelectedProjectId(project_id ?? "")
                            }
                            style={{ width: 360, maxWidth: "100%" }}
                          />
                          <Button onClick={refresh}>Refresh</Button>
                        </Space>
                      </div>

                      <div>
                        <div style={{ marginBottom: 6, fontWeight: 500 }}>
                          Account OpenAI API key
                        </div>
                        <div style={{ marginTop: 8, marginBottom: 8 }}>
                          {apiKeyStatus?.account ? (
                            <Space wrap>
                              <Tag color="green">Configured</Tag>
                              <Text type="secondary">
                                Updated{" "}
                                <TimeAgo date={apiKeyStatus.account.updated} />
                              </Text>
                              <Text type="secondary">
                                Last used{" "}
                                {apiKeyStatus.account.last_used ? (
                                  <TimeAgo
                                    date={apiKeyStatus.account.last_used}
                                  />
                                ) : (
                                  "Never"
                                )}
                              </Text>
                            </Space>
                          ) : (
                            <Tag>Not configured</Tag>
                          )}
                        </div>
                        <Space wrap>
                          <Password
                            value={accountApiKey}
                            onChange={(e) => setAccountApiKey(e.target.value)}
                            placeholder="sk-..."
                            visibilityToggle
                            style={{ width: 360, maxWidth: "100%" }}
                          />
                          <Button
                            type="primary"
                            loading={savingScope === "account"}
                            onClick={async () => {
                              const key = accountApiKey.trim();
                              if (!key) {
                                setError("Account API key cannot be empty.");
                                return;
                              }
                              setSavingScope("account");
                              setError("");
                              try {
                                const completed = await runFreshAuthAction(
                                  async () => {
                                    await webapp_client.conat_client.hub.system.setOpenAiApiKey(
                                      {
                                        api_key: key,
                                        browser_id: webapp_client.browser_id,
                                      },
                                    );
                                  },
                                );
                                if (!completed) {
                                  return;
                                }
                                setAccountApiKey("");
                                refreshAfterPaymentSourceChange();
                              } catch (err) {
                                setError(`${err}`);
                              } finally {
                                setSavingScope("");
                              }
                            }}
                          >
                            Save account key
                          </Button>
                          <Popconfirm
                            title="Delete account API key?"
                            okText="Delete"
                            okButtonProps={{ danger: true }}
                            onConfirm={async () => {
                              setDeletingScope("account");
                              setError("");
                              try {
                                const completed = await runFreshAuthAction(
                                  async () => {
                                    await webapp_client.conat_client.hub.system.deleteOpenAiApiKey(
                                      {
                                        browser_id: webapp_client.browser_id,
                                      },
                                    );
                                  },
                                );
                                if (!completed) {
                                  return;
                                }
                                refreshAfterPaymentSourceChange();
                              } catch (err) {
                                setError(`${err}`);
                              } finally {
                                setDeletingScope("");
                              }
                            }}
                          >
                            <Button
                              danger
                              loading={deletingScope === "account"}
                              disabled={!apiKeyStatus?.account}
                            >
                              Delete account key
                            </Button>
                          </Popconfirm>
                        </Space>
                      </div>

                      <div>
                        <div style={{ marginBottom: 6, fontWeight: 500 }}>
                          Project OpenAI API key
                        </div>
                        <div style={{ marginTop: 8, marginBottom: 8 }}>
                          {!selectedProjectId.trim() ? (
                            <Tag>Select a project above</Tag>
                          ) : apiKeyStatus?.project ? (
                            <Space wrap>
                              <Tag color="green">Configured</Tag>
                              <Text type="secondary">
                                Updated{" "}
                                <TimeAgo date={apiKeyStatus.project.updated} />
                              </Text>
                              <Text type="secondary">
                                Last used{" "}
                                {apiKeyStatus.project.last_used ? (
                                  <TimeAgo
                                    date={apiKeyStatus.project.last_used}
                                  />
                                ) : (
                                  "Never"
                                )}
                              </Text>
                            </Space>
                          ) : (
                            <Tag>Not configured for selected project</Tag>
                          )}
                        </div>
                        <Space wrap>
                          <Password
                            value={projectApiKey}
                            onChange={(e) => setProjectApiKey(e.target.value)}
                            placeholder="sk-..."
                            visibilityToggle
                            style={{ width: 360, maxWidth: "100%" }}
                            disabled={!selectedProjectId.trim()}
                          />
                          <Button
                            type="primary"
                            loading={savingScope === "project"}
                            disabled={!selectedProjectId.trim()}
                            onClick={async () => {
                              const key = projectApiKey.trim();
                              if (!key) {
                                setError("Project API key cannot be empty.");
                                return;
                              }
                              if (!selectedProjectId.trim()) {
                                setError("Select a project first.");
                                return;
                              }
                              setSavingScope("project");
                              setError("");
                              try {
                                const completed = await runFreshAuthAction(
                                  async () => {
                                    await webapp_client.conat_client.hub.system.setOpenAiApiKey(
                                      {
                                        project_id: selectedProjectId,
                                        api_key: key,
                                        browser_id: webapp_client.browser_id,
                                      },
                                    );
                                  },
                                );
                                if (!completed) {
                                  return;
                                }
                                setProjectApiKey("");
                                refreshAfterPaymentSourceChange();
                              } catch (err) {
                                setError(`${err}`);
                              } finally {
                                setSavingScope("");
                              }
                            }}
                          >
                            Save project key
                          </Button>
                          <Popconfirm
                            title="Delete project API key?"
                            okText="Delete"
                            okButtonProps={{ danger: true }}
                            onConfirm={async () => {
                              if (!selectedProjectId.trim()) return;
                              setDeletingScope("project");
                              setError("");
                              try {
                                const completed = await runFreshAuthAction(
                                  async () => {
                                    await webapp_client.conat_client.hub.system.deleteOpenAiApiKey(
                                      {
                                        project_id: selectedProjectId,
                                        browser_id: webapp_client.browser_id,
                                      },
                                    );
                                  },
                                );
                                if (!completed) {
                                  return;
                                }
                                refreshAfterPaymentSourceChange();
                              } catch (err) {
                                setError(`${err}`);
                              } finally {
                                setDeletingScope("");
                              }
                            }}
                          >
                            <Button
                              danger
                              loading={deletingScope === "project"}
                              disabled={
                                !selectedProjectId.trim() ||
                                !apiKeyStatus?.project
                              }
                            >
                              Delete project key
                            </Button>
                          </Popconfirm>
                        </Space>
                      </div>
                    </Space>
                  ),
                },
              ]),
          ...(lite
            ? []
            : [
                {
                  key: "credentials",
                  label: `Codex subscription credentials (${credentials.length})`,
                  children: (
                    <Table
                      rowKey="id"
                      size="small"
                      dataSource={orderedCredentials}
                      columns={columns as any}
                      pagination={false}
                      locale={{
                        emptyText: "No saved subscription credentials.",
                      }}
                      footer={() => (
                        <Button
                          size="small"
                          onClick={() => void startDeviceAuth(undefined, true)}
                          loading={deviceAuthActionPending}
                          disabled={deviceAuth?.state === "pending"}
                        >
                          Add
                        </Button>
                      )}
                    />
                  ),
                },
              ]),
        ]}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );

  if (hidePanelChrome || embedded) {
    return content;
  }

  return (
    <Panel
      style={{ marginTop: "15px" }}
      header={
        <>
          <Icon name="robot" /> {CODEX_CREDENTIALS_LABELS.title}
        </>
      }
    >
      {content}
    </Panel>
  );
}
