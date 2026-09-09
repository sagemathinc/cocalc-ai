import { createContext, useContext } from "react";
import { validateArtifact, validateArtifactPublication } from "@cocalc/chat";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

// Read-only viewers have document rows, not live ChatActions or a writable syncdb.
export const ReadonlyArtifactRows = createContext<any[]>([]);

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
                  {publication.snapshot.markdown.slice(0, 240)}
                </div>
                {current ? (
                  <details>
                    <summary>Current document</summary>
                    <StaticMarkdown value={current.input} />
                  </details>
                ) : (
                  <div role="status">Current document unavailable</div>
                )}
                <details>
                  <summary>Published version</summary>
                  <StaticMarkdown value={publication.snapshot.markdown} />
                </details>
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
