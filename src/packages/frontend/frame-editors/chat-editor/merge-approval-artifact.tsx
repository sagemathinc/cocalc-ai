/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The merge approval card. The chat holds only request ids: everything shown
here is what the hub read from GitHub and recorded, except the agent's note,
which is labelled as the agent's. Deciding goes to the hub from this browser
session, with fresh auth (and a second factor where the repo requires it).
*/

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, Space, Tag, Typography } from "antd";
import type {
  MergeApprovalDecisionKind,
  MergeApprovalView,
} from "@cocalc/util/merge-approval";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import CopyToClipBoard from "@cocalc/frontend/components/copy-to-clipboard";
import { Icon } from "@cocalc/frontend/components/icon";

// While a request is open, the card checks for a decision this often.
const REFRESH_MS = 30_000;

function mergeApprovalsApi() {
  // Hub calls from the browser carry this session; decide is bound to it.
  return webapp_client.conat_client.hub.mergeApprovals;
}

const STATUS_COLOR: Record<string, string> = {
  pending: "processing",
  approved: "success",
  rejected: "error",
  superseded: "default",
  withdrawn: "default",
  expired: "default",
};

function isGitHubUrl(url: string): boolean {
  return /^https:\/\/github\.com\//.test(url);
}

const SHA = /^[0-9a-f]{40}$/;

// GitHub's diff of exactly these commits, which can't change later.
function compareUrl(repo: string, base?: string, head?: string) {
  if (!base || !head || !SHA.test(base) || !SHA.test(head)) return undefined;
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/.test(repo)) return undefined;
  return `https://github.com/${repo}/compare/${base}...${head}`;
}

function when(iso?: string): string {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "";
}

export function MergeApprovalArtifact({
  requestIds,
  readOnly = false,
  fontSize,
}: {
  requestIds: string[];
  readOnly?: boolean;
  fontSize?: number;
}) {
  const [views, setViews] = useState<MergeApprovalView[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const key = requestIds.join(",");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setViews(await mergeApprovalsApi().get({ request_ids: requestIds }));
      setError("");
    } catch (err) {
      setError(`${(err as any)?.message ?? err}`);
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  const anyPending = views?.some((v) => v.request.status === "pending");
  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyPending, load]);

  return (
    <KeyboardBoundary
      className="smc-vfill"
      boundary="merge-approval-card"
      style={{
        padding: 12,
        overflow: "auto",
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
        fontSize,
      }}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size={12}>
        <Space wrap>
          <Typography.Text type="secondary">
            Shown from what CoCalc read from GitHub when each request was made.
          </Typography.Text>
          <Button
            size="small"
            icon={<Icon name="refresh" />}
            loading={loading}
            onClick={() => void load()}
            aria-label="Refresh merge approvals"
          >
            Refresh
          </Button>
        </Space>
        {error && (
          <Alert
            type="info"
            showIcon
            title={
              /approvers only/.test(error)
                ? "Only merge approvers can see and decide these requests."
                : error
            }
          />
        )}
        {views?.length === 0 && !error && (
          <Alert
            type="warning"
            showIcon
            title="No such merge approval requests."
          />
        )}
        {views?.map((view) => (
          <MergeApprovalRequestCard
            key={view.request.id}
            view={view}
            readOnly={readOnly}
            onDecided={load}
          />
        ))}
      </Space>
    </KeyboardBoundary>
  );
}

function MergeApprovalRequestCard({
  view,
  readOnly,
  onDecided,
}: {
  view: MergeApprovalView;
  readOnly: boolean;
  onDecided: () => Promise<void>;
}) {
  const { request, decision } = view;
  const snap = request.github_snapshot;
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<MergeApprovalDecisionKind>();
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  async function decide(kind: MergeApprovalDecisionKind) {
    setBusy(kind);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        await mergeApprovalsApi().decide({
          request_id: request.id,
          decision: kind,
          comment,
        });
      });
      await onDecided();
    } catch (err) {
      setError(`${(err as any)?.message ?? err}`);
    } finally {
      setBusy(undefined);
    }
  }

  const heading = `${request.repo} #${request.pr_number}`;
  const diffUrl = compareUrl(request.repo, snap.base_sha, request.head_sha);
  const checkSummary = snap.check_summary ?? {
    total: snap.checks.length,
    failing: 0,
    pending: 0,
  };
  const reviewSummary = snap.review_summary ?? {
    total: snap.reviews.length,
    changes_requested: 0,
    approved: 0,
  };
  return (
    <section
      aria-label={`Merge approval for ${heading}`}
      style={{
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 6,
        padding: 12,
      }}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size={8}>
        <Space wrap align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>
            {isGitHubUrl(snap.html_url) ? (
              <a href={snap.html_url} target="_blank" rel="noopener noreferrer">
                {heading}
              </a>
            ) : (
              heading
            )}
          </Typography.Title>
          <Tag color={STATUS_COLOR[request.status] ?? "default"}>
            {request.status}
          </Tag>
        </Space>
        <Typography.Text strong>{snap.title}</Typography.Text>
        {diffUrl ? (
          <Space wrap>
            <Button
              type="primary"
              icon={<Icon name="github" />}
              href={diffUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Review the diff of exactly this head
            </Button>
            <Typography.Text type="secondary">
              GitHub's diff of {request.base_ref} at{" "}
              <code>{snap.base_sha.slice(0, 12)}</code> to{" "}
              <code>{request.head_sha.slice(0, 12)}</code>; it can't change
              later. Approve only what you reviewed there.
            </Typography.Text>
          </Space>
        ) : (
          <Alert
            type="warning"
            showIcon
            title="No pinned diff link for this request: review the exact head on GitHub before approving."
          />
        )}
        <dl style={{ margin: 0 }}>
          <dt>Merge into</dt>
          <dd>
            <code>{request.base_ref}</code> from <code>{snap.head_ref}</code> by{" "}
            {snap.author}
          </dd>
          <dt>Exact head</dt>
          <dd>
            <CopyToClipBoard
              value={request.head_sha}
              display={request.head_sha.slice(0, 12)}
              size="small"
              ariaLabel="Copy the full head commit SHA"
            />
          </dd>
          <dt>Change</dt>
          <dd>
            +{snap.additions} −{snap.deletions} in {snap.changed_files} files
          </dd>
          <dt>Checks</dt>
          <dd>
            {checkSummary.total} total, {checkSummary.failing} failing,{" "}
            {checkSummary.pending} pending
          </dd>
          <dt>Reviews</dt>
          <dd>
            {reviewSummary.total} total, {reviewSummary.changes_requested}{" "}
            requesting changes, {reviewSummary.approved} approving
          </dd>
        </dl>
        {(checkSummary.failing > 0 || reviewSummary.changes_requested > 0) && (
          <Alert
            type="warning"
            showIcon
            title={[
              checkSummary.failing > 0 &&
                `${checkSummary.failing} failing check${checkSummary.failing === 1 ? "" : "s"}`,
              reviewSummary.changes_requested > 0 &&
                `${reviewSummary.changes_requested} review${reviewSummary.changes_requested === 1 ? "" : "s"} requesting changes`,
            ]
              .filter(Boolean)
              .join("; ")}
          />
        )}
        {snap.files.length > 0 && (
          <details>
            <summary>Files, as listed by GitHub at request time</summary>
            <ul style={{ margin: 0 }}>
              {snap.files.map((f) => (
                <li key={f.filename}>
                  <code>{f.filename}</code> +{f.additions} −{f.deletions}
                </li>
              ))}
            </ul>
            {snap.files_truncated && (
              <Typography.Text type="secondary">
                Not all files are listed.
              </Typography.Text>
            )}
          </details>
        )}
        <details>
          <summary>
            Checks ({snap.checks.length} shown) and reviews (
            {snap.reviews.length} shown)
          </summary>
          <ul style={{ margin: 0 }}>
            {snap.checks.map((c, i) => (
              <li key={`c${i}`}>
                {c.name}: {c.conclusion ?? c.status}
              </li>
            ))}
            {snap.reviews.map((r, i) => (
              <li key={`r${i}`}>
                {r.author}: {r.state}
                {r.commit_id && r.commit_id !== request.head_sha
                  ? " (on an earlier commit)"
                  : ""}
              </li>
            ))}
          </ul>
          {(snap.checks_truncated || snap.reviews_truncated) && (
            <Typography.Text type="secondary">
              Not all {snap.checks_truncated ? "checks" : ""}
              {snap.checks_truncated && snap.reviews_truncated ? " and " : ""}
              {snap.reviews_truncated ? "reviews" : ""} are listed; the counts
              above include them. Failures and change requests are listed first.
            </Typography.Text>
          )}
        </details>
        <Typography.Text type="secondary">
          Read from GitHub {when(snap.read_at)}. Requested by{" "}
          {request.requested_by.agent_label
            ? `agent ${request.requested_by.agent_label}`
            : "an agent"}
          ; open until {when(request.expires_at)}.
        </Typography.Text>
        {request.agent_note && (
          <div>
            <Typography.Text strong>
              Note from the requesting agent (not checked by CoCalc)
            </Typography.Text>
            <div
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                borderLeft: `3px solid ${UI_COLORS.border}`,
                paddingLeft: 8,
                color: UI_COLORS.secondary,
              }}
            >
              {request.agent_note}
            </div>
          </div>
        )}
        {decision && (
          <Alert
            type={decision.decision === "approve" ? "success" : "warning"}
            showIcon
            title={`${decision.decision === "approve" ? "Approved" : "Rejected"} ${when(decision.decided_at)}`}
            description={decision.comment || undefined}
          />
        )}
        {request.status === "pending" && !readOnly && (
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Input.TextArea
              aria-label={`Comment for ${heading}`}
              placeholder="Comment (optional)"
              value={comment}
              maxLength={2000}
              autoSize={{ minRows: 1, maxRows: 4 }}
              onChange={(e) => setComment(e.target.value)}
            />
            <Space wrap>
              <Button
                type="primary"
                loading={busy === "approve"}
                disabled={!!busy}
                onClick={() => void decide("approve")}
              >
                Approve head {request.head_sha.slice(0, 12)}
              </Button>
              <Button
                danger
                loading={busy === "reject"}
                disabled={!!busy}
                onClick={() => void decide("reject")}
              >
                Reject
              </Button>
            </Space>
          </Space>
        )}
        {error && <Alert type="error" showIcon title={error} />}
      </Space>
      <FreshAuthModal {...freshAuthModalProps} />
    </section>
  );
}
