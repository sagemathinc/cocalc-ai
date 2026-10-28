/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
"My key may be compromised": after the owner confirms the RunPod account is
used only for CoCalc (and fresh authentication), CoCalc stops launching with the
key and terminates every pod in that RunPod account, including ones it didn't
start, until the owner deletes the key at RunPod. Like Terminate all, this stays
available whatever the dashboard's data looks like.
*/

import { useState } from "react";
import { Alert, Button, Checkbox, Modal, Space, Typography } from "antd";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import type { GpuCompromiseStatus } from "@cocalc/util/gpu/types";

const RUNPOD_API_KEYS_URL = "https://console.runpod.io/user/credentials";

export type ReportCompromised = (opts: {
  confirm_cocalc_only: boolean;
}) => Promise<GpuCompromiseStatus>;

function errorText(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function CompromiseStatus({ status }: { status: GpuCompromiseStatus }) {
  let title: string;
  let type: "success" | "info" | "warning" | "error";
  if (status.closed) {
    type = "success";
    title =
      "Done: RunPod rejects the key, nothing is left in the account, and CoCalc removed its copy.";
  } else if (status.provider_rejected) {
    type = "error";
    title =
      "RunPod rejects the key, but some pods CoCalc started may still be running.";
  } else if (status.awaiting_provider_revocation) {
    type = "warning";
    title =
      "The account is clean, but RunPod still accepts the key. Delete it on RunPod's Credentials page; CoCalc keeps watching until then.";
  } else {
    type = "info";
    title =
      "CoCalc is terminating every pod in the RunPod account and launches nothing with this key.";
  }
  const counts: string[] = [];
  if (status.managed_pods != null)
    counts.push(
      `${plural(status.managed_pods, "pod")} CoCalc started not yet confirmed terminated`,
    );
  if (status.provider_pods != null)
    counts.push(
      `${plural(status.provider_pods, "pod")} in the RunPod account at the last complete listing`,
    );
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Alert
        role="status"
        type={type}
        showIcon
        title={title}
        description={
          counts.length > 0 || status.listing_failed ? (
            <>
              {counts.length > 0 && <div>{counts.join("; ")}.</div>}
              {status.listing_failed && (
                <div>
                  The last pass couldn&apos;t list the RunPod account; CoCalc
                  retries.
                </div>
              )}
            </>
          ) : undefined
        }
      />
      {status.warning && (
        <Alert
          role="alert"
          type="warning"
          showIcon
          title="What you need to do"
          description={status.warning}
        />
      )}
    </Space>
  );
}

export function ReportCompromisedKey({
  report,
  onReported,
}: {
  report: ReportCompromised;
  // after each report: the key may now be gone (closed), so the caller
  // refreshes what it shows about the key
  onReported?: (status: GpuCompromiseStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<GpuCompromiseStatus>();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  async function submit() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError("");
    try {
      let result: GpuCompromiseStatus | undefined;
      const completed = await runFreshAuthAction(async () => {
        result = await report({ confirm_cocalc_only: true });
      });
      if (completed && result) {
        setStatus(result);
        onReported?.(result);
        setOpen(false);
        setConfirmed(false);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Compromised key" style={{ marginTop: 20 }}>
      <Button danger onClick={() => setOpen(true)}>
        My key may be compromised
      </Button>
      {status && (
        <div style={{ marginTop: 12 }}>
          <CompromiseStatus status={status} />
        </div>
      )}
      <Modal
        open={open}
        title="Report your RunPod key as compromised?"
        okText="Terminate everything and stop using the key"
        okButtonProps={{ danger: true, loading: busy, disabled: !confirmed }}
        cancelButtonProps={{ disabled: busy }}
        onOk={() => void submit()}
        onCancel={() => {
          if (busy) return;
          setOpen(false);
          setConfirmed(false);
          setError("");
        }}
        destroyOnHidden
      >
        <p>
          CoCalc stops launching with this key and terminates{" "}
          <strong>every pod in your RunPod account</strong>, including pods
          CoCalc didn&apos;t start, on every pass, until you delete the key on{" "}
          <a href={RUNPOD_API_KEYS_URL} target="_blank" rel="noreferrer">
            RunPod&apos;s Credentials page
          </a>
          . CoCalc can&apos;t revoke a RunPod key itself. Once RunPod rejects
          the key and nothing is left, CoCalc removes its copy.
        </p>
        <Checkbox
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        >
          This RunPod account is used only for CoCalc, so terminating every pod
          in it is fine.
        </Checkbox>
        {!confirmed && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
            If the account also runs pods outside CoCalc, delete the key on
            RunPod yourself instead, then remove it from CoCalc above.
          </Typography.Paragraph>
        )}
        {error && (
          <Alert
            role="alert"
            type="error"
            showIcon
            title={error}
            style={{ marginTop: 8 }}
          />
        )}
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </section>
  );
}
