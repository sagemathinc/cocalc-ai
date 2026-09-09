import { captureArtifactSelection } from "../artifact-selection";
import { artifactKey } from "@cocalc/chat";

const target = { artifact_id: "doc", thread_id: "thread" };
const artifact = {
  ...artifactKey(target),
  ...target,
  schema_version: 1 as const,
  kind: "markdown" as const,
  title: "Example",
  input: "**same** 🙂 same",
};

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

test("anchors the second occurrence in rendered text, not Markdown source", () => {
  const el = document.createElement("div");
  el.innerHTML = "<strong>same</strong> 🙂 same";
  document.body.append(el);
  const range = document.createRange();
  range.setStart(el.lastChild!, 4);
  range.setEnd(el.lastChild!, 8);
  window.getSelection()!.addRange(range);
  const feedback = captureArtifactSelection(
    el,
    artifact,
    window.getSelection(),
  );
  expect(feedback.quote).toBe("same");
  expect(feedback.start).toBe(8);
  expect(feedback.markdown).toBe(artifact.input);
});

test("whole-document feedback needs no selection", () => {
  const el = document.createElement("div");
  el.textContent = "same";
  expect(captureArtifactSelection(el, artifact, null).quote).toBe("");
});

test("rejects selections outside the artifact", () => {
  const el = document.createElement("div");
  const other = document.createElement("div");
  other.textContent = "outside";
  document.body.append(el, other);
  const range = document.createRange();
  range.selectNodeContents(other);
  window.getSelection()!.addRange(range);
  expect(() =>
    captureArtifactSelection(el, artifact, window.getSelection()),
  ).toThrow(/inside/);
});
