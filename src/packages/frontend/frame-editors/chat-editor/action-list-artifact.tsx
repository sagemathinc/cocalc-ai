import { useState } from "react";
import { Alert, Button, Input, Select, Space } from "antd";
import type {
  ActionDecision,
  ArtifactFeedback,
  ArtifactRecord,
  ProposedAction,
} from "@cocalc/chat";
import {
  proposedActionBase,
  validateActionDecisions,
  validateArtifactFeedback,
} from "@cocalc/chat";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

interface ReviewDraft extends ActionDecision {
  sourceBase: string;
}

function restoreDrafts(key?: string): Record<string, ReviewDraft> {
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 100_000) return {};
    const rows = JSON.parse(raw);
    const decisions = validateActionDecisions(rows);
    return Object.fromEntries(
      decisions.map((decision, index) => {
        const sourceBase = rows[index].sourceBase;
        if (typeof sourceBase !== "string" || sourceBase.length > 20_000)
          throw Error("Invalid review base");
        return [decision.proposal.id, { ...decision, sourceBase }];
      }),
    );
  } catch {
    return {};
  }
}
export function ActionListArtifact({
  artifact,
  onReview,
  historical,
  storageKey,
}: {
  artifact: ArtifactRecord;
  onReview?: (feedback: ArtifactFeedback) => Promise<void>;
  historical: boolean;
  storageKey?: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>(() =>
    restoreDrafts(historical ? undefined : storageKey),
  );
  const [error, setError] = useState("");
  const [staging, setStaging] = useState(false);
  const proposals = artifact.actions!;
  const draftFor = (proposal: ProposedAction): ReviewDraft =>
    Object.prototype.hasOwnProperty.call(drafts, proposal.id)
      ? drafts[proposal.id]
      : {
          proposal,
          sourceBase: proposedActionBase(proposal),
          decision: "undecided",
          comment: "",
        };
  const stale = proposals.some(
    (p) => draftFor(p).sourceBase !== proposedActionBase(p),
  );
  const patch = (proposal: ProposedAction, values: Partial<ReviewDraft>) => {
    const next = {
      ...drafts,
      [proposal.id]: { ...draftFor(proposal), ...values },
    };
    setDrafts(next);
    if (storageKey && !historical) {
      try {
        // Store only proposals still present; these are review drafts, not authorization.
        localStorage.setItem(
          storageKey,
          JSON.stringify(
            proposals
              .filter((p) => Object.prototype.hasOwnProperty.call(next, p.id))
              .map((p) => next[p.id]),
          ),
        );
      } catch {
        setError(
          "Review is available in this frame, but could not be saved in this browser.",
        );
      }
    }
  };
  return (
    <KeyboardBoundary
      className="smc-vfill"
      style={{
        minHeight: 0,
        padding: 12,
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      <Space wrap style={{ flexShrink: 0 }}>
        <strong>{artifact.title}</strong>
        <Button
          disabled={!onReview || historical || stale || staging}
          onClick={() => {
            if (!onReview || stale || historical) return;
            try {
              const feedback = validateArtifactFeedback({
                schema_version: 1,
                thread_id: artifact.thread_id,
                artifact_id: artifact.artifact_id,
                title: artifact.title,
                markdown: artifact.input,
                rendered_text: "Action review",
                start: 0,
                end: 0,
                quote: "",
                action_review: proposals.map((p) => {
                  const d = draftFor(p);
                  return {
                    proposal: d.proposal,
                    decision: d.decision,
                    comment: d.comment,
                  };
                }),
              });
              setStaging(true);
              void onReview(feedback)
                .catch((err) => setError(String(err)))
                .finally(() => setStaging(false));
            } catch (err) {
              setError(String(err));
            }
          }}
        >
          Return decisions to agent
        </Button>
      </Space>
      <div role="note">
        Review drafts only. Decisions are staged in the originating chat for you
        to send; nothing is executed here.
      </div>
      {historical && (
        <div role="note">Published proposals, not the current review.</div>
      )}
      {error && <Alert type="warning" title={error} />}
      <div style={{ overflow: "auto", flex: "1 1 0", minHeight: 0 }}>
        {proposals.map((proposal) => {
          const draft = draftFor(proposal);
          const changed = draft.sourceBase !== proposedActionBase(proposal);
          const disabled = !onReview || historical || changed;
          return (
            <section
              key={proposal.id}
              aria-label={proposal.title}
              style={{
                border: `1px solid ${UI_COLORS.border}`,
                borderRadius: 6,
                padding: 12,
                marginTop: 12,
              }}
            >
              <strong style={{ display: "block", marginBottom: 8 }}>
                {proposal.title}
              </strong>
              {changed && (
                <Alert
                  type="warning"
                  title="Proposal changed since you started reviewing."
                  description={
                    <Button
                      onClick={() =>
                        patch(proposal, {
                          proposal,
                          sourceBase: proposedActionBase(proposal),
                          decision: "undecided",
                          comment: draft.comment,
                        })
                      }
                    >
                      Use updated proposal
                    </Button>
                  }
                />
              )}
              <label style={{ display: "block", marginBottom: 8 }}>
                Target
                <Input
                  aria-label={`Target for ${proposal.title}`}
                  value={draft.proposal.target}
                  disabled={disabled}
                  onChange={(e) =>
                    patch(proposal, {
                      proposal: { ...draft.proposal, target: e.target.value },
                      decision: "undecided",
                    })
                  }
                />
              </label>
              <label style={{ display: "block" }}>
                Draft
                <Input.TextArea
                  aria-label={`Draft for ${proposal.title}`}
                  value={draft.proposal.draft}
                  disabled={disabled}
                  autoSize={{ minRows: 3, maxRows: 14 }}
                  onChange={(e) =>
                    patch(proposal, {
                      proposal: { ...draft.proposal, draft: e.target.value },
                      decision: "undecided",
                    })
                  }
                />
              </label>
              <Space wrap style={{ marginTop: 8 }}>
                <Select
                  aria-label={`Decision for ${proposal.title}`}
                  value={draft.decision}
                  disabled={disabled}
                  style={{ width: 170 }}
                  options={[
                    { value: "undecided", label: "Not reviewed" },
                    { value: "approve", label: "Approve exact draft" },
                    { value: "reject", label: "Reject" },
                  ]}
                  onChange={(decision) => patch(proposal, { decision })}
                />
                {proposal.outcome && (
                  <span>Agent reports: {proposal.outcome}</span>
                )}
              </Space>
              {proposal.receipt && (
                <div style={{ whiteSpace: "pre-wrap" }}>
                  Execution receipt: {proposal.receipt}
                </div>
              )}
              <Input.TextArea
                aria-label={`Comment for ${proposal.title}`}
                placeholder="Optional review comment"
                value={draft.comment}
                disabled={disabled}
                onChange={(e) => patch(proposal, { comment: e.target.value })}
                autoSize={{ minRows: 1, maxRows: 4 }}
                style={{ marginTop: 8 }}
              />
            </section>
          );
        })}
      </div>
    </KeyboardBoundary>
  );
}
