import { readArtifact, validateArtifactPublication } from "@cocalc/chat";
import type { ArtifactPublication, ArtifactRecord } from "@cocalc/chat";

export interface ArtifactCatalogEntry {
  publication: ArtifactPublication;
  current?: ArtifactRecord;
  title: string;
  kind: ArtifactRecord["kind"];
  text: string;
  created: number;
  published: number;
}

// Publications provide discoverability even when the producing message is archived.
// The fixed SyncDB key date on the current record is NOT an edit timestamp.
export function artifactCatalog(syncdb: any): ArtifactCatalogEntry[] {
  if (!syncdb || (syncdb.get_state && syncdb.get_state() !== "ready"))
    return [];
  const found = syncdb.get({ event: "chat-artifact-publication" });
  const rows = found?.toJS?.() ?? found ?? [];
  const entries = new Map<string, ArtifactCatalogEntry>();
  for (const row of rows) {
    try {
      const publication = validateArtifactPublication(row);
      const key = JSON.stringify([
        publication.thread_id,
        publication.artifact_id,
      ]);
      const published = Date.parse(publication.published_at ?? "") || 0;
      const previous = entries.get(key);
      if (previous) {
        previous.created = Math.min(previous.created, published);
        if (previous.published >= published) continue;
      }
      let current: ArtifactRecord | undefined;
      try {
        current = readArtifact(syncdb, publication).artifact;
      } catch {
        // A historical publication is still useful when the current row is absent.
      }
      const data = current ?? publication.snapshot;
      const kind =
        current?.kind ??
        (data.file
          ? "file"
          : data.commit
            ? "commit"
            : data.github_pr
              ? "github-pr"
              : data.actions
                ? "actions"
                : "markdown");
      const title = data.theme?.title || data.title;
      entries.set(key, {
        publication,
        current,
        title,
        kind,
        text: [
          title,
          data.title,
          data.theme?.description,
          current?.input ?? publication.snapshot.markdown,
          JSON.stringify(
            data.file ?? data.commit ?? data.github_pr ?? data.actions ?? "",
          ),
        ]
          .join("\n")
          .toLowerCase(),
        created: previous?.created ?? published,
        published,
      });
    } catch {
      // Ignore malformed records without hiding the rest of the catalog.
    }
  }
  return Array.from(entries.values());
}

export function filterArtifacts(
  entries: ArtifactCatalogEntry[],
  {
    query = "",
    threadId,
    kind,
    sort = "published",
  }: {
    query?: string;
    threadId?: string;
    kind?: string;
    sort?: "published" | "created" | "title";
  },
) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter(
      (entry) =>
        (!threadId || entry.publication.thread_id === threadId) &&
        (!kind || entry.kind === kind) &&
        words.every((word) => entry.text.includes(word)),
    )
    .sort(
      (a, b) =>
        (sort === "title"
          ? a.title.localeCompare(b.title)
          : b[sort] - a[sort]) ||
        a.publication.artifact_id.localeCompare(b.publication.artifact_id),
    );
}
