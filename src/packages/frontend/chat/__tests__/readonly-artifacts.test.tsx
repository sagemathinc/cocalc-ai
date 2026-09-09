import { render, screen } from "@testing-library/react";
import { artifactKey, artifactPublicationKey } from "@cocalc/chat";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { ArtifactCards } from "../artifacts";
import { ReadonlyArtifactRows } from "../readonly-artifacts";

const target = { thread_id: "thread", artifact_id: "artifact" };
const publication = {
  ...artifactPublicationKey(target, "publish"),
  ...target,
  schema_version: 1,
  operation_id: "publish",
  message_id: "message",
  snapshot: { title: "Draft", markdown: "# Original heading" },
};
const current = {
  ...artifactKey(target),
  ...target,
  schema_version: 1,
  kind: "markdown",
  title: "Draft",
  input:
    '# Current heading\n\n<a href="javascript:window.attack()">unsafe link</a>\n\n<script>window.attack()</script>\n\n![remote](https://example.com/tracking.png)',
};

test("read-only cards expose sanitized current and historical text without actions", () => {
  const { container } = render(
    <FileContext.Provider value={{ noSanitize: true }}>
      <ReadonlyArtifactRows.Provider value={[current, publication]}>
        <ArtifactCards threadId="thread" messageId="message" />
      </ReadonlyArtifactRows.Provider>
    </FileContext.Provider>,
  );
  const summary = screen.getByText("Current document");
  summary.focus();
  expect(document.activeElement).toBe(summary);
  // Native details/summary provides keyboard activation without custom handlers.
  expect(summary.tagName).toBe("SUMMARY");
  expect(summary.parentElement?.tagName).toBe("DETAILS");
  expect(screen.getByText("Current heading")).toBeTruthy();
  expect(screen.getByText("Original heading")).toBeTruthy();
  expect(
    screen.getByText("unsafe link").closest("a")?.getAttribute("href"),
  ).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector('img[src*="example.com"]')).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Edit|Comment|Send/ }),
  ).toBeNull();
  expect(container.querySelector('[contenteditable="true"]')).toBeNull();
});

test("publication remains readable when current row is absent, and is scoped to its turn", () => {
  const { rerender } = render(
    <ReadonlyArtifactRows.Provider value={[publication]}>
      <ArtifactCards threadId="thread" messageId="message" />
    </ReadonlyArtifactRows.Provider>,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Current document unavailable",
  );
  expect(screen.getByText("Published version")).toBeTruthy();
  rerender(
    <ReadonlyArtifactRows.Provider value={[publication]}>
      <ArtifactCards threadId="other-thread" messageId="message" />
    </ReadonlyArtifactRows.Provider>,
  );
  expect(screen.queryByText("Published version")).toBeNull();
});
