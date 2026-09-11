import { createContext, lazy, Suspense, useContext, useState } from "react";
import {
  artifactGitHubPRUrl,
  validateArtifact,
  validateArtifactPublication,
} from "@cocalc/chat";
import type { ArtifactPublication } from "@cocalc/chat";
import { ArtifactCard } from "./artifact-card";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { useProjectContext } from "@cocalc/frontend/project/context";

const FileArtifact = lazy(() =>
  import("@cocalc/frontend/frame-editors/chat-editor/file-artifact").then(
    ({ FileArtifact }) => ({ default: FileArtifact }),
  ),
);

// Read-only viewers have document rows, not live ChatActions or a writable syncdb.
export const ReadonlyArtifactRows = createContext<any[]>([]);

function ReadonlyFilePreview({
  publication,
}: {
  publication: ArtifactPublication;
}) {
  const [open, setOpen] = useState(false);
  const { project_id, actions } = useProjectContext();
  return (
    <>
      <div role="note">
        This card stores a file reference, not historical file contents.
      </div>
      {project_id && actions && (
        <details onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>Preview current saved file</summary>
          {open && (
            <div className="smc-vfill" style={{ height: "min(65vh, 640px)" }}>
              <Suspense fallback={<div role="status">Loading preview...</div>}>
                <FileArtifact
                  projectId={project_id}
                  historical
                  artifact={{
                    event: "chat-artifact",
                    schema_version: 1,
                    thread_id: publication.thread_id,
                    artifact_id: publication.artifact_id,
                    sender_id: publication.sender_id,
                    date: publication.date,
                    kind: "file",
                    title: publication.snapshot.title,
                    input: publication.snapshot.markdown,
                    file: publication.snapshot.file,
                  }}
                />
              </Suspense>
            </div>
          )}
        </details>
      )}
    </>
  );
}

function PublishedObject({
  snapshot,
}: {
  snapshot: ArtifactPublication["snapshot"];
}) {
  return (
    <>
      {snapshot.commit && (
        <div>
          <code>{snapshot.commit.sha}</code>
          <div>{snapshot.commit.path}</div>
          <div>{snapshot.commit.branch}</div>
        </div>
      )}
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
                <ArtifactCard publication={publication} current={current} />
                {publication.snapshot.file ? (
                  <ReadonlyFilePreview publication={publication} />
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
                        commit: current.commit,
                        theme: current.theme,
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
