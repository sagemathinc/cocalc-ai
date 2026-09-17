import { validateArtifactFeedback } from "@cocalc/chat";
import type { ActionDecision } from "@cocalc/chat";

export function ActionReviewNotice({
  title,
  decisions,
}: {
  title: string;
  decisions: ActionDecision[];
}) {
  const count = (value: ActionDecision["decision"]) =>
    decisions.filter((item) => item.decision === value).length;
  return (
    <details style={{ minWidth: 0, maxWidth: "100%" }}>
      <summary>
        Decisions on {title}: {count("approve")} approved, {count("reject")}{" "}
        rejected, {count("undecided")} not reviewed
      </summary>
      <div role="note">Exact review snapshot. Approval is not execution.</div>
      {decisions.map(({ proposal, decision, comment }) => (
        <section
          key={proposal.id}
          aria-label={`Reviewed action: ${proposal.title}`}
          style={{
            marginTop: 8,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          <strong>{proposal.title}</strong>
          <div>
            Decision:{" "}
            {decision === "approve"
              ? "Approved exact draft"
              : decision === "reject"
                ? "Rejected"
                : "Not reviewed"}
          </div>
          <div>Target: {proposal.target}</div>
          <div>{proposal.draft}</div>
          {comment && <div>Comment: {comment}</div>}
        </section>
      ))}
    </details>
  );
}

export function ArtifactFeedbackNotice({ value }: { value: unknown }) {
  if (!value) return null;
  try {
    const feedback = validateArtifactFeedback(value);
    if (feedback.action_review)
      return (
        <ActionReviewNotice
          title={feedback.title}
          decisions={feedback.action_review}
        />
      );
    return (
      <details style={{ marginTop: 8 }}>
        <summary>Feedback on {feedback.title}</summary>
        <blockquote style={{ whiteSpace: "pre-wrap" }}>
          {feedback.quote || "Whole document"}
        </blockquote>
      </details>
    );
  } catch {
    return <div role="status">Artifact feedback unavailable</div>;
  }
}
