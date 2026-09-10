import { createContext, useContext } from "react";
import {
  artifactGitHubPRUrl,
  validateArtifact,
  validateArtifactPublication,
} from "@cocalc/chat";
import type { ArtifactPublication } from "@cocalc/chat";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

// Read-only viewers have document rows, not live ChatActions or a writable syncdb.
export const ReadonlyArtifactRows = createContext<any[]>([]);

function PublishedObject({
  snapshot,
}: {
  snapshot: ArtifactPublication["snapshot"];
}) {
  return (
    <>
      {snapshot.github_pr && (
        <div>
          <a
            href={artifactGitHubPRUrl(snapshot.github_pr)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {snapshot.github_pr.repository} #{snapshot.github_pr.number}
          </a>
          <div>
            {snapshot.github_pr.draft ? "Draft · " : ""}
            {snapshot.github_pr.state} · Checks: {snapshot.github_pr.checks}
          </div>
          <div>Cached metadata retrieved {snapshot.github_pr.fetched_at}</div>
          <div style={{ overflowWrap: "anywhere" }}>
            Base <code>{snapshot.github_pr.base_sha}</code> → Head{" "}
            <code>{snapshot.github_pr.head_sha}</code>
          </div>
        </div>
      )}
      {snapshot.actions?.map((proposal) => (
        <section
          key={proposal.id}
          aria-label={`Proposed action: ${proposal.title}`}
          style={{
            marginTop: 8,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          <strong>{proposal.title}</strong>
          <div>Target: {proposal.target}</div>
          <div>{proposal.draft}</div>
          {proposal.outcome && <div>Agent reports: {proposal.outcome}</div>}
          {proposal.receipt && <div>Execution receipt: {proposal.receipt}</div>}
        </section>
      ))}
      <StaticMarkdown value={snapshot.markdown} />
    </>
  );
}

export function ReadonlyArtifactCards({
  threadId,
  messageId,
}: {
  threadId?: string;
  messageId?: string;
}) {
  const rows = useContext(ReadonlyArtifactRows);
  const context = useFileContext();
  if (!threadId || !messageId) return null;
  return (
    <FileContext.Provider
      value={{
        ...context,
        noSanitize: false,
        disableMarkdownCodebar: true,
        urlTransform: (url, tag) =>
          tag?.toLowerCase() === "img" ? "" : context.urlTransform?.(url, tag),
      }}
    >
      {rows
        .filter(
          (row) =>
            row.event === "chat-artifact-publication" &&
            row.thread_id === threadId &&
            row.message_id === messageId,
        )
        .map((row, index) => {
          try {
            const publication = validateArtifactPublication(row);
            const currentRow = rows.find(
              (value) =>
                value.event === "chat-artifact" &&
                value.thread_id === threadId &&
                value.artifact_id === publication.artifact_id,
            );
            let current;
            try {
              current = validateArtifact(currentRow);
            } catch {
              /* A historical file may contain only the publication. */
            }
            return (
              <section
                key={publication.operation_id}
                aria-label={`Artifact: ${publication.snapshot.title}`}
                style={{
                  border: `1px solid ${UI_COLORS.border}`,
                  borderRadius: 6,
                  padding: 10,
                  marginTop: 8,
                  color: UI_COLORS.text,
                  background: UI_COLORS.surface,
                }}
              >
                <strong>{publication.snapshot.title}</strong>
                <div style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>
                  {publication.snapshot.file?.path ??
                    publication.snapshot.markdown.slice(0, 240)}
                </div>
                {publication.snapshot.file ? (
                  <div role="note">
                    File reference only. Open the file through the project file
                    browser; no historical file contents are stored in this
                    card.
                  </div>
                ) : current && current.kind !== "file" ? (
                  <details>
                    <summary>
                      {current.kind === "actions"
                        ? "Current proposals"
                        : current.kind === "github-pr"
                          ? "Current PR metadata"
                          : "Current document"}
                    </summary>
                    <PublishedObject
                      snapshot={{
                        title: current.title,
                        markdown: current.input,
                        actions: current.actions,
                        github_pr: current.github_pr,
                      }}
                    />
                  </details>
                ) : (
                  <div role="status">Current document unavailable</div>
                )}
                {!publication.snapshot.file && (
                  <details>
                    <summary>Published version</summary>
                    <PublishedObject snapshot={publication.snapshot} />
                  </details>
                )}
              </section>
            );
          } catch {
            return (
              <div role="status" key={index}>
                Artifact unavailable
              </div>
            );
          }
        })}
    </FileContext.Provider>
  );
}
