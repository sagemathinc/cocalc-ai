import { fireEvent, render, screen } from "@testing-library/react";
import { artifactKey, artifactPublicationKey } from "@cocalc/chat";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { ArtifactCards } from "../artifacts";
import { ReadonlyArtifactRows } from "../readonly-artifacts";

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => mockProjectContext,
}));
const mockProjectContext = { project_id: "project", actions: {} };
const mockFilePreview = jest.fn((props) => (
  <div role="document">{props.artifact.file.path}</div>
));
jest.mock("@cocalc/frontend/frame-editors/chat-editor/file-artifact", () => ({
  FileArtifact: (props) => mockFilePreview(props),
}));

test("read-only file preview loads on request in the host project without feedback", async () => {
  mockFilePreview.mockClear();
  render(
    <ReadonlyArtifactRows.Provider
      value={[
        {
          ...publication,
          snapshot: { title: "Plan", markdown: "", file: { path: "/plan.md" } },
        },
      ]}
    >
      <ArtifactCards threadId="thread" messageId="message" />
    </ReadonlyArtifactRows.Provider>,
  );
  expect(mockFilePreview).not.toHaveBeenCalled();
  const summary = screen.getByText("Preview current saved file");
  summary.focus();
  expect(document.activeElement).toBe(summary);
  expect(summary.tagName).toBe("SUMMARY");
  const details = summary.parentElement! as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(await screen.findByRole("document")).toHaveTextContent("/plan.md");
  expect(mockFilePreview.mock.calls[0][0]).toMatchObject({
    projectId: "project",
    historical: true,
    artifact: { file: { path: "/plan.md" } },
  });
  expect(mockFilePreview.mock.calls[0][0].onComment).toBeUndefined();
  details.open = false;
  fireEvent(details, new Event("toggle"));
  expect(screen.queryByRole("document")).toBeNull();
});

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
  expect(screen.getAllByText("Original heading").length).toBeGreaterThan(0);
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

test("read-only action lists distinguish current proposals from published drafts", () => {
  const proposal = {
    id: "reply",
    title: "Reply",
    target: "Ticket 123",
    draft: "Original proposal",
  };
  const { container } = render(
    <ReadonlyArtifactRows.Provider
      value={[
        {
          ...current,
          kind: "actions",
          input: "",
          actions: [{ ...proposal, draft: "Updated proposal" }],
        },
        {
          ...publication,
          snapshot: { title: "Replies", markdown: "", actions: [proposal] },
        },
      ]}
    >
      <ArtifactCards threadId="thread" messageId="message" />
    </ReadonlyArtifactRows.Provider>,
  );
  expect(screen.getByText("Current proposals")).toBeTruthy();
  expect(screen.getByText("Updated proposal")).toBeTruthy();
  expect(screen.getByText("Original proposal")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.querySelector("input,textarea,select")).toBeNull();
});

test("read-only PR cards display cached metadata and a canonical external link", () => {
  const pr = {
    repository: "sagemathinc/cocalc-ai",
    number: 509,
    state: "open",
    draft: true,
    checks: "unknown",
    fetched_at: "2026-09-10T00:00:00Z",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
  };
  render(
    <ReadonlyArtifactRows.Provider
      value={[
        {
          ...publication,
          snapshot: { title: "PR", markdown: "Description", github_pr: pr },
        },
      ]}
    >
      <ArtifactCards threadId="thread" messageId="message" />
    </ReadonlyArtifactRows.Provider>,
  );
  expect(screen.getByText(/Cached metadata retrieved/)).toBeTruthy();
  // Expand the native details element before querying its accessible link.
  screen.getByText("Published version").parentElement!.setAttribute("open", "");
  expect(
    screen.getByRole("link", { name: "sagemathinc/cocalc-ai #509" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/sagemathinc/cocalc-ai/pull/509",
  );
  expect(
    screen.queryByRole("button", { name: /Refresh|Fetch|Review/ }),
  ).toBeNull();
});
