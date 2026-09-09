import type { ArtifactFeedback, ArtifactRecord } from "@cocalc/chat";
import { validateArtifactFeedback } from "@cocalc/chat";

// Read-only rendered documents do not get the native caret behavior of inputs.
// Keep keyboard extension local so it cannot capture adjacent chat content.
export function extendArtifactSelection(
  element: HTMLElement,
  selection: Selection | null,
  key: string,
  byWord: boolean,
): boolean {
  if (
    !selection?.modify ||
    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)
  ) {
    return false;
  }
  const backward = key === "ArrowLeft" || key === "ArrowUp";
  if (
    !element.contains(selection.anchorNode) ||
    !element.contains(selection.focusNode)
  ) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(!backward);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  selection.modify(
    "extend",
    backward ? "backward" : "forward",
    key === "ArrowUp" || key === "ArrowDown"
      ? "line"
      : byWord
        ? "word"
        : "character",
  );
  if (!element.contains(selection.focusNode)) {
    selection.setBaseAndExtent(
      selection.anchorNode!,
      selection.anchorOffset,
      element,
      backward ? 0 : element.childNodes.length,
    );
  }
  return true;
}

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
