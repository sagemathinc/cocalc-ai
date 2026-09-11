import {
  captureArtifactSelection,
  extendArtifactSelection,
} from "../artifact-selection";
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
  delete (window.getSelection() as any).modify;
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

test.each(["ArrowRight", "ArrowLeft"])(
  "keyboard selection starts inside the document: %s",
  (key) => {
    const el = document.createElement("div");
    el.textContent = "Example";
    document.body.append(el);
    const selection = window.getSelection()!;
    selection.modify = jest.fn();
    expect(extendArtifactSelection(el, selection, key, true)).toBe(true);
    expect(selection.anchorNode).toBe(el);
    expect(selection.anchorOffset).toBe(key === "ArrowLeft" ? 1 : 0);
    expect(selection.modify).toHaveBeenCalledWith(
      "extend",
      key === "ArrowLeft" ? "backward" : "forward",
      "word",
    );
  },
);

test("keyboard selection cannot extend into adjacent chat text", () => {
  const el = document.createElement("div");
  el.textContent = "Example";
  const outside = document.createTextNode("Private adjacent message");
  document.body.append(el, outside);
  const selection = window.getSelection()!;
  selection.modify = jest.fn(() => selection.extend(outside, 7));
  expect(extendArtifactSelection(el, selection, "ArrowDown", false)).toBe(true);
  expect(selection.modify).toHaveBeenCalledWith("extend", "forward", "line");
  expect(selection.toString()).toBe("Example");
  expect(el.contains(selection.focusNode)).toBe(true);
});

test("leaves unrelated keys and browsers without modify unchanged", () => {
  const el = document.createElement("div");
  const selection = window.getSelection()!;
  expect(extendArtifactSelection(el, selection, "ArrowRight", false)).toBe(
    false,
  );
  selection.modify = jest.fn();
  expect(extendArtifactSelection(el, selection, "Tab", false)).toBe(false);
  expect(selection.modify).not.toHaveBeenCalled();
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
