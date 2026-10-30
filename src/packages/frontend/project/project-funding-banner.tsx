/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// GPU use in a project, paid by a collaborator's own RunPod key
// (PROJECT_FUNDING.md §6). Every collaborator sees:
// - a request, when someone (or the project itself) asked to use GPUs and
//   nobody has approved: a collaborator with their own key can approve it
//   (fresh sign-in); others are told how;
// - the approval, while one is active: who pays, how much is left, until
//   when. Its funder can lower it or revoke it here.

import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  InputNumber,
  Modal,
  Space,
  Typography,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectFundingState } from "@cocalc/util/gpu/project-funding";
import { KEY_RPC_TIMEOUT_MS } from "@cocalc/util/gpu/provider-keys";
import {
  approvalLine,
  defaultTerms,
  fundingTerms,
  requestLine,
  type FundingForm,
} from "./project-funding-model";

const { Text, Link } = Typography;

const REFRESH_MS = 60_000;
const DISMISSED_KEY = "cocalc-project-funding-dismissed";

function dismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function dismiss(id: string) {
  try {
    const s = dismissed();
    s.add(id);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...s].slice(-200)));
  } catch {
    // only a convenience
  }
}

export function ProjectFundingBanner({
  projectId,
  // in project settings: always shown, with "approve" even without a request
  always = false,
}: {
  projectId: string;
  always?: boolean;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const [state, setState] = useState<ProjectFundingState>();
  // whether this viewer has their own usable key (can approve)
  const [canFund, setCanFund] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => dismissed());
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const hub = webapp_client.conat_client.hub;
    const next = await hub.gpu.projectFunding({ project_id: projectId });
    let funds = false;
    try {
      const key = await hub.system.getGpuProviderKeyStatus({
        provider: "runpod",
        timeout: KEY_RPC_TIMEOUT_MS,
      });
      funds = !!key?.entitled && !!key?.connected;
    } catch {
      // they just can't approve from here
    }
    if (mine !== generation.current) return;
    setState(next);
    setCanFund(funds);
  }, [projectId]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (!disposed) void load().catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(refresh, REFRESH_MS);
    refresh();
    return () => {
      disposed = true;
      generation.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(`${(err as Error)?.message ?? err}`);
      return false;
    } finally {
      setBusy(false);
      await load().catch(() => {});
    }
  };

  const approve = async (form: FundingForm) => {
    const ok = await act(() =>
      runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.gpu.approveProjectFunding({
          project_id: projectId,
          terms: fundingTerms(form),
          operation_id: crypto.randomUUID(),
          ...(form.raise_key_budget_to
            ? { raise_key_budget_to: form.raise_key_budget_to }
            : {}),
          browser_id: webapp_client.browser_id,
        });
      }),
    );
    if (ok) setApproving(false);
  };

  const revoke = (approval_id: string) =>
    act(() =>
      webapp_client.conat_client.hub.gpu.revokeProjectFunding({ approval_id }),
    );

  const approval = state?.approval;
  const request = state?.request;
  const isFunder =
    approval != null && approval.funder_account_id === account_id;
  const showRequest =
    request != null && !approval && (always || !hidden.has(request.id));
  const showApproval =
    approval != null &&
    (always || isFunder || !hidden.has(approval.approval_id));

  const dialog = (
    <>
      <ApproveDialog
        open={approving}
        busy={busy}
        error={error}
        onCancel={() => setApproving(false)}
        onApprove={(form) => void approve(form)}
      />
      <Modal
        open={confirmRevoke}
        title="End this approval?"
        okText="End it and terminate its GPUs"
        okButtonProps={{ danger: true }}
        onOk={() => {
          setConfirmRevoke(false);
          if (approval) void revoke(approval.approval_id);
        }}
        onCancel={() => setConfirmRevoke(false)}
      >
        No new GPU can be launched in this project on your account, and CoCalc
        terminates the GPUs it paid for.
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );

  if (!showRequest && !showApproval && !always) return dialog;

  return (
    <div aria-live="polite" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
      {error && !approving ? (
        <Alert
          closable
          showIcon
          type="error"
          title="That didn't work"
          description={error}
          onClose={() => setError(undefined)}
          style={{ marginBottom: 8 }}
        />
      ) : null}
      {showRequest && request ? (
        <Alert
          banner
          showIcon
          type="warning"
          closable={!always}
          onClose={() => {
            dismiss(request.id);
            setHidden(dismissed());
          }}
          title={`GPUs were requested in this project: ${requestLine(request)}`}
          description={
            <Space orientation="vertical" size={6}>
              <Text>
                GPU use here is paid by a collaborator's own RunPod account,
                approved for an amount and a number of days.
              </Text>
              {canFund ? (
                <Space wrap>
                  <Button
                    type="primary"
                    size="small"
                    disabled={busy}
                    onClick={() => setApproving(true)}
                  >
                    Approve with my RunPod account…
                  </Button>
                </Space>
              ) : (
                <Text type="secondary">
                  To approve, connect your own RunPod key in{" "}
                  <Link
                    href={joinUrlPath(appBasePath, "settings", "connectors")}
                  >
                    Settings → Connectors
                  </Link>
                  .
                </Text>
              )}
            </Space>
          }
        />
      ) : null}
      {showApproval && approval ? (
        <Alert
          banner
          showIcon
          type="info"
          closable={!always && !isFunder}
          onClose={() => {
            dismiss(approval.approval_id);
            setHidden(dismissed());
          }}
          title={approvalLine(approval, isFunder)}
          description={
            isFunder ? (
              <Space wrap>
                <Button
                  size="small"
                  danger
                  disabled={busy}
                  onClick={() => setConfirmRevoke(true)}
                >
                  End this approval…
                </Button>
              </Space>
            ) : null
          }
        />
      ) : null}
      {always && !approval ? (
        <Space orientation="vertical" size={6}>
          <Text>
            Nobody pays for GPUs in this project now. A collaborator can approve
            GPU use here, paid by their own RunPod account.
          </Text>
          {canFund ? (
            <Button disabled={busy} onClick={() => setApproving(true)}>
              Approve GPU use in this project…
            </Button>
          ) : (
            <Text type="secondary">
              To approve, connect your own RunPod key in Settings → Connectors.
            </Text>
          )}
        </Space>
      ) : null}
      {dialog}
    </div>
  );
}

function ApproveDialog({
  open,
  busy,
  error,
  onCancel,
  onApprove,
}: {
  open: boolean;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onApprove: (form: FundingForm) => void;
}) {
  const [form, setForm] = useState<FundingForm>(defaultTerms);
  const [keyLeft, setKeyLeft] = useState<number>();
  const [raise, setRaise] = useState(true);

  useEffect(() => {
    if (!open) return;
    setForm(defaultTerms);
    void webapp_client.conat_client.hub.gpu
      .budget({})
      .then((b) => setKeyLeft(Number(b.available_usd)))
      .catch(() => setKeyLeft(undefined));
  }, [open]);

  const needsRaise = keyLeft != null && form.amount > keyLeft;
  const ends = new Date(Date.now() + form.days * 86_400_000);

  return (
    <Modal
      open={open}
      title="Approve GPU use in this project"
      okText="Approve (you'll sign in again)"
      okButtonProps={{ loading: busy, disabled: !(form.amount > 0) }}
      onCancel={onCancel}
      onOk={() =>
        onApprove({
          ...form,
          raise_key_budget_to:
            needsRaise && raise ? `${form.amount}` : undefined,
        })
      }
    >
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        <Text>
          Anyone who can run code in this project — any collaborator, and code
          in its terminal — can launch GPUs paid by <b>your RunPod account</b>,
          up to the amount below, until {ends.toLocaleDateString()}. CoCalc can
          tell which collaborator launched a GPU only when they used their own
          account, not from the project's terminal. You can end the approval at
          any time; that terminates the GPUs it paid for.
        </Text>
        <Space wrap>
          <Text>Amount (USD)</Text>
          <InputNumber
            aria-label="Amount in US dollars"
            min={1}
            max={100000}
            precision={2}
            value={form.amount}
            onChange={(v) => setForm({ ...form, amount: Number(v ?? 0) })}
          />
          {[50, 100, 400].map((v) => (
            <Button
              key={v}
              size="small"
              onClick={() => setForm({ ...form, amount: v })}
            >
              ${v}
            </Button>
          ))}
        </Space>
        <Space wrap>
          <Text>For</Text>
          <InputNumber
            aria-label="Number of days"
            min={1}
            max={120}
            precision={0}
            value={form.days}
            onChange={(v) => setForm({ ...form, days: Number(v ?? 1) })}
          />
          <Text>days</Text>
          {[1, 7, 30].map((v) => (
            <Button
              key={v}
              size="small"
              onClick={() => setForm({ ...form, days: v })}
            >
              {v} {v === 1 ? "day" : "days"}
            </Button>
          ))}
        </Space>
        <Checkbox
          checked={form.agents_allowed}
          onChange={(e) =>
            setForm({ ...form, agents_allowed: e.target.checked })
          }
        >
          Agents working in this project may launch GPUs under it
        </Checkbox>
        <Collapse
          size="small"
          items={[
            {
              key: "caps",
              label: "Limits (optional)",
              children: (
                <Space orientation="vertical">
                  <Space wrap>
                    <Text>At most $/hour in all</Text>
                    <InputNumber
                      aria-label="Most US dollars per hour"
                      min={0.01}
                      precision={2}
                      value={form.max_hourly_usd}
                      onChange={(v) =>
                        setForm({
                          ...form,
                          max_hourly_usd: v == null ? undefined : Number(v),
                        })
                      }
                    />
                  </Space>
                  <Space wrap>
                    <Text>GPUs (pods) at once</Text>
                    <InputNumber
                      aria-label="Most pods at once"
                      min={1}
                      max={100}
                      precision={0}
                      value={form.max_concurrent_pods}
                      onChange={(v) =>
                        setForm({
                          ...form,
                          max_concurrent_pods:
                            v == null ? undefined : Number(v),
                        })
                      }
                    />
                  </Space>
                  <Space wrap>
                    <Text>Hours per pod</Text>
                    <InputNumber
                      aria-label="Most hours per pod"
                      min={1}
                      max={168}
                      precision={0}
                      value={form.max_runtime_hours}
                      onChange={(v) =>
                        setForm({
                          ...form,
                          max_runtime_hours: v == null ? undefined : Number(v),
                        })
                      }
                    />
                  </Space>
                </Space>
              ),
            },
          ]}
        />
        {needsRaise ? (
          <Checkbox
            checked={raise}
            onChange={(e) => setRaise(e.target.checked)}
          >
            Your RunPod key's CoCalc budget has ${keyLeft?.toFixed(2)} left:
            also raise it to ${form.amount.toFixed(2)}
          </Checkbox>
        ) : null}
        {error ? <Alert type="error" showIcon title={error} /> : null}
      </Space>
    </Modal>
  );
}
