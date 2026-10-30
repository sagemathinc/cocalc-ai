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
//   when. Its funder can end it here.

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
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectFundingState } from "@cocalc/util/gpu/project-funding";
import { KEY_RPC_TIMEOUT_MS } from "@cocalc/util/gpu/provider-keys";
import { joinUrlPath } from "@cocalc/util/url-path";
import {
  approvalLine,
  defaultTerms,
  fundingTerms,
  keyRaiseTarget,
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

const connectorsHref = () => joinUrlPath(appBasePath, "settings", "connectors");

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
  // the project's funding couldn't be read: never shown as "nobody pays"
  const [loadError, setLoadError] = useState<string>();
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
    let next: ProjectFundingState | undefined;
    let readError: string | undefined;
    try {
      next = await hub.gpu.projectFunding({ project_id: projectId });
    } catch (err) {
      readError = `${(err as Error)?.message ?? err}`;
    }
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
    if (next) setState(next);
    setLoadError(readError);
    setCanFund(funds);
  }, [projectId]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (!disposed) void load();
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

  // One approval attempt, with its own operation id: a fresh-auth retry or a
  // second click after a lost answer names the same approval (the server
  // then returns it instead of refusing a second one).
  const approve = async (form: FundingForm, operation_id: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const done = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.gpu.approveProjectFunding({
          project_id: projectId,
          terms: fundingTerms(form),
          operation_id,
          ...(form.raise_key_budget_to
            ? { raise_key_budget_to: form.raise_key_budget_to }
            : {}),
          browser_id: webapp_client.browser_id,
        });
      });
      // a canceled sign-in approved nothing: the dialog stays open
      if (done) setApproving(false);
    } catch (err) {
      setError(`${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(false);
      await load();
    }
  };

  const revoke = async (approval_id: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await webapp_client.conat_client.hub.gpu.revokeProjectFunding({
        approval_id,
      });
    } catch (err) {
      setError(`${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(false);
      await load();
    }
  };

  const approval = state?.approval;
  const request = state?.request;
  const isFunder =
    approval != null && approval.funder_account_id === account_id;
  const showRequest =
    request != null && !approval && (always || !hidden.has(request.id));
  const showApproval =
    approval != null &&
    (always || isFunder || !hidden.has(approval.approval_id));

  const dialogs = (
    <>
      <ApproveDialog
        open={approving}
        busy={busy}
        error={error}
        onCancel={() => setApproving(false)}
        onApprove={(form, operation_id) => void approve(form, operation_id)}
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

  if (!showRequest && !showApproval && !always) return dialogs;

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
      {always && loadError && !state ? (
        <Alert
          showIcon
          type="warning"
          title="This project's GPU funding couldn't be read"
          description={loadError}
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
                  <Link href={connectorsHref()}>Settings → Connectors</Link>.
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
      {/* "nobody pays" only from a successful read */}
      {always && state && !approval ? (
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
              To approve, connect your own RunPod key in{" "}
              <Link href={connectorsHref()}>Settings → Connectors</Link>.
            </Text>
          )}
        </Space>
      ) : null}
      {dialogs}
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
  onApprove: (form: FundingForm, operation_id: string) => void;
}) {
  const [form, setForm] = useState<FundingForm>(defaultTerms);
  // the key budget: what's left, and its total (a raise sets a new total)
  const [key, setKey] = useState<{ available: number; authorized: number }>();
  const [raise, setRaise] = useState(true);
  // one id per opening of the dialog: every retry of this approval uses it
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    setForm(defaultTerms);
    setOperationId(crypto.randomUUID());
    void webapp_client.conat_client.hub.gpu
      .budget({})
      .then((b) =>
        setKey({
          // the view floors what's left at 0 and reports an overrun apart
          available: Number(b.available_usd) - Number(b.over_budget_usd ?? 0),
          authorized: Number(b.authorized_usd),
        }),
      )
      .catch(() => setKey(undefined));
  }, [open]);

  // other terms make another approval
  const edit = (next: FundingForm) => {
    setForm(next);
    setOperationId(crypto.randomUUID());
  };

  const raiseTo = keyRaiseTarget(key, form.amount);
  const ends = new Date(Date.now() + form.days * 86_400_000);

  return (
    <Modal
      open={open}
      title="Approve GPU use in this project"
      okText="Approve (you'll sign in again)"
      okButtonProps={{ loading: busy, disabled: !(form.amount > 0) }}
      onCancel={onCancel}
      onOk={() =>
        onApprove(
          {
            ...form,
            raise_key_budget_to: raiseTo != null && raise ? raiseTo : undefined,
          },
          operationId,
        )
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
          <label htmlFor="project-funding-amount">Amount (USD)</label>
          <InputNumber
            id="project-funding-amount"
            min={1}
            max={100000}
            precision={2}
            value={form.amount}
            onChange={(v) => edit({ ...form, amount: Number(v ?? 0) })}
          />
          {[50, 100, 400].map((v) => (
            <Button
              key={v}
              size="small"
              onClick={() => edit({ ...form, amount: v })}
            >
              ${v}
            </Button>
          ))}
        </Space>
        <Space wrap>
          <label htmlFor="project-funding-days">Days</label>
          <InputNumber
            id="project-funding-days"
            min={1}
            max={120}
            precision={0}
            value={form.days}
            onChange={(v) => edit({ ...form, days: Number(v ?? 1) })}
          />
          {[1, 7, 30].map((v) => (
            <Button
              key={v}
              size="small"
              onClick={() => edit({ ...form, days: v })}
            >
              {v} {v === 1 ? "day" : "days"}
            </Button>
          ))}
        </Space>
        <Checkbox
          checked={form.agents_allowed}
          onChange={(e) => edit({ ...form, agents_allowed: e.target.checked })}
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
                    <label htmlFor="project-funding-hourly">
                      At most $/hour in all
                    </label>
                    <InputNumber
                      id="project-funding-hourly"
                      min={0.01}
                      precision={2}
                      value={form.max_hourly_usd}
                      onChange={(v) =>
                        edit({
                          ...form,
                          max_hourly_usd: v == null ? undefined : Number(v),
                        })
                      }
                    />
                  </Space>
                  <Space wrap>
                    <label htmlFor="project-funding-pods">
                      GPUs (pods) at once
                    </label>
                    <InputNumber
                      id="project-funding-pods"
                      min={1}
                      max={100}
                      precision={0}
                      value={form.max_concurrent_pods}
                      onChange={(v) =>
                        edit({
                          ...form,
                          max_concurrent_pods:
                            v == null ? undefined : Number(v),
                        })
                      }
                    />
                  </Space>
                  <Space wrap>
                    <label htmlFor="project-funding-hours">Hours per pod</label>
                    <InputNumber
                      id="project-funding-hours"
                      min={1}
                      max={168}
                      precision={0}
                      value={form.max_runtime_hours}
                      onChange={(v) =>
                        edit({
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
        {raiseTo != null && key ? (
          <Checkbox
            checked={raise}
            onChange={(e) => {
              // the raise is part of the approval's terms: another attempt
              setRaise(e.target.checked);
              setOperationId(crypto.randomUUID());
            }}
          >
            {`Your RunPod key's CoCalc budget has $${Math.max(key.available, 0).toFixed(2)} left: also raise it from $${key.authorized.toFixed(2)} to $${raiseTo}`}
          </Checkbox>
        ) : null}
        {error ? <Alert type="error" showIcon title={error} /> : null}
      </Space>
    </Modal>
  );
}
