/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// An agent's GPU requests on the owner's RunPod key, in the project the
// agent works in (step 6b-2). Approving names exactly the stored request
// and its hash, after a fresh sign-in; nothing else approves. Declining and
// revoking only narrow. Only the key owner sees anything here: requests are
// the owner's own.

import { Alert, Button, Collapse, Modal, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

import {
  GPU_AGENT_REQUESTS_PROJECT_DETAIL_FIELD,
  type GpuAgentRequestView,
} from "@cocalc/conat/hub/api/gpu";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import {
  activeApprovals,
  exactRequest,
  pendingRequests,
  requestLines,
  requestSummary,
  timeOfDay,
} from "@cocalc/frontend/gpu/agent-request-model";
import { subscribeProjectDetailInvalidation } from "@cocalc/frontend/project/use-project-field";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const { Text } = Typography;

export function GpuAgentRequestBanner({ projectId }: { projectId: string }) {
  const [views, setViews] = useState<GpuAgentRequestView[]>([]);
  // why an approved launch would still be refused now
  const [paused, setPaused] = useState<"kill_switch" | "alert" | null>(null);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  // what the owner is asked to confirm revoking
  const [confirmRevoke, setConfirmRevoke] = useState<GpuAgentRequestView>();
  // the clock the banner hides expired requests and approvals by
  const [now, setNow] = useState(() => Date.now());
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const generation = useRef(0);

  const load = async () => {
    const mine = ++generation.current;
    const hub = webapp_client.conat_client.hub.gpu;
    const next = await hub.agentRequests({ project_id: projectId });
    let pause: typeof paused = null;
    if (next.length > 0) {
      try {
        const budget = await hub.budget({});
        pause = budget.kill_switch
          ? "kill_switch"
          : budget.paused
            ? "alert"
            : null;
      } catch {
        // only an explanation; the approval itself doesn't depend on it
      }
    }
    if (mine !== generation.current) return;
    setViews(next);
    setPaused(pause);
  };

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (disposed) return;
      void load().catch(() => {
        // An optional shortcut: `cocalc gpu agent requests` still works
        // when this query is briefly unavailable.
      });
    };
    const unsubscribe = subscribeProjectDetailInvalidation(
      projectId,
      (fields) => {
        if (fields.includes(GPU_AGENT_REQUESTS_PROJECT_DETAIL_FIELD)) {
          refresh();
        }
      },
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    refresh();
    return () => {
      disposed = true;
      generation.current++;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId]);

  // A pending request ends at its expiry and an approval at its own, with
  // nothing to announce it: at the next one, hide what ended and look again.
  useEffect(() => {
    const ends = views
      .flatMap((v) => [
        v.state === "pending" ? Date.parse(v.expires_at) : NaN,
        v.grant?.state === "active" ? Date.parse(v.grant.expires_at) : NaN,
      ])
      .filter((t) => Number.isFinite(t) && t > now);
    if (ends.length === 0) return;
    const delay = Math.min(Math.min(...ends) - Date.now() + 250, 2 ** 31 - 1);
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        void load().catch(() => {});
      },
      Math.max(delay, 0),
    );
    return () => clearTimeout(timer);
  }, [views, now]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(`${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(undefined);
      await load().catch(() => {});
    }
  };

  const approve = (view: GpuAgentRequestView) =>
    act(view.request_id, async () => {
      await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.gpu.approveAgentRequest({
          request_id: view.request_id,
          // the hash of exactly what is shown: a changed request fails
          expected_hash: view.payload_hash,
          browser_id: webapp_client.browser_id,
        });
      });
    });

  const deny = (view: GpuAgentRequestView) =>
    act(view.request_id, () =>
      webapp_client.conat_client.hub.gpu.denyAgentRequest({
        request_id: view.request_id,
      }),
    );

  const revoke = (view: GpuAgentRequestView) =>
    act(view.grant!.grant_id, () =>
      webapp_client.conat_client.hub.gpu.revokeAgentGrant({
        grant_id: view.grant!.grant_id,
      }),
    );

  const pending = pendingRequests(views).filter(
    (v) => Date.parse(v.expires_at) > now,
  );
  const active = activeApprovals(views).filter(
    (v) => Date.parse(v.grant!.expires_at) > now,
  );
  if (pending.length === 0 && active.length === 0 && !error) {
    return <FreshAuthModal {...freshAuthModalProps} />;
  }

  const pausedNote =
    paused === "kill_switch"
      ? "New GPU launches are paused by your kill switch, so even an approved launch is refused until you resume them."
      : paused === "alert"
        ? "New GPU launches with your key are paused until a GPU alert is resolved, so even an approved launch is refused until then."
        : null;

  return (
    <div aria-live="polite" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
      {error ? (
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
      {pending.map((view) => (
        <Alert
          key={view.request_id}
          banner
          showIcon
          type="warning"
          title={`An agent asks to launch a GPU on your RunPod key: ${requestSummary(view)}`}
          description={
            <Space orientation="vertical" size={6}>
              <Text>
                Approve exactly this launch, once. It is charged to your own
                RunPod account; CoCalc adds nothing.
              </Text>
              <div>
                {requestLines(view).map(({ label, value }) => (
                  <div key={label}>
                    <Text type="secondary">{label}: </Text>
                    <Text>{value}</Text>
                  </div>
                ))}
              </div>
              <Text type="secondary">
                The request expires at {timeOfDay(view.expires_at)}; an approval
                lasts until the agent's session ends (at most 30 minutes).
              </Text>
              {pausedNote ? <Text type="warning">{pausedNote}</Text> : null}
              <Collapse
                size="small"
                items={[
                  {
                    key: "exact",
                    label: "The exact request",
                    children: (
                      <pre
                        style={{
                          margin: 0,
                          whiteSpace: "pre-wrap",
                          // the 64-character hash and long image names wrap
                          // at narrow widths and high zoom
                          overflowWrap: "anywhere",
                          maxWidth: "100%",
                        }}
                      >
                        {exactRequest(view)}
                      </pre>
                    ),
                  },
                ]}
              />
              <Space wrap>
                <Button
                  type="primary"
                  size="small"
                  loading={busy === view.request_id}
                  disabled={busy != null && busy !== view.request_id}
                  onClick={() => void approve(view)}
                >
                  Approve this launch
                </Button>
                <Button
                  size="small"
                  disabled={busy != null}
                  onClick={() => void deny(view)}
                >
                  Decline
                </Button>
              </Space>
            </Space>
          }
        />
      ))}
      {active.map((view) => (
        <Alert
          key={view.grant!.grant_id}
          banner
          showIcon
          type="info"
          title={`You approved an agent's GPU launch: ${requestSummary(view)}`}
          description={
            <Space wrap>
              <Text>
                {view.grant!.launches_used > 0
                  ? "Its one launch was used."
                  : "Not launched yet."}{" "}
                No new launch after {timeOfDay(view.grant!.expires_at)}.
              </Text>
              <Button
                size="small"
                danger
                loading={busy === view.grant!.grant_id}
                disabled={busy != null && busy !== view.grant!.grant_id}
                onClick={() => setConfirmRevoke(view)}
              >
                Revoke
              </Button>
            </Space>
          }
        />
      ))}
      <Modal
        open={confirmRevoke != null}
        title="Revoke this approval?"
        okText="Revoke and terminate"
        okButtonProps={{ danger: true }}
        onOk={() => {
          const view = confirmRevoke;
          setConfirmRevoke(undefined);
          if (view) void revoke(view);
        }}
        onCancel={() => setConfirmRevoke(undefined)}
      >
        No new launch, and CoCalc terminates the pod it launched.
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
