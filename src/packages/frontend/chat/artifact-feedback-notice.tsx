import { validateArtifactFeedback } from "@cocalc/chat";

export function ArtifactFeedbackNotice({ value }: { value: unknown }) {
  if (!value) return null;
  try {
    const feedback = validateArtifactFeedback(value);
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
