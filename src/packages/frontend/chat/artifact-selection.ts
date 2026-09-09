import type { ArtifactFeedback, ArtifactRecord } from "@cocalc/chat";
import { validateArtifactFeedback } from "@cocalc/chat";

export function captureArtifactSelection(
  element: HTMLElement,
  artifact: ArtifactRecord,
  selection: Selection | null,
): ArtifactFeedback {
  const rendered_text = element.textContent ?? "";
  let start = 0;
  let end = 0;
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    if (
      !element.contains(range.startContainer) ||
      !element.contains(range.endContainer)
    ) {
      throw Error("Select a passage inside this artifact");
    }
    const prefix = range.cloneRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(range.startContainer, range.startOffset);
    start = prefix.cloneContents().textContent?.length ?? 0;
    end = start + (range.cloneContents().textContent?.length ?? 0);
  }
  return validateArtifactFeedback({
    schema_version: 1,
    artifact_id: artifact.artifact_id,
    thread_id: artifact.thread_id,
    title: artifact.title,
    markdown: artifact.input,
    rendered_text,
    start,
    end,
    quote: rendered_text.slice(start, end),
  });
}
