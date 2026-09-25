/** A selected artifact reference is identity metadata, not an access grant. */
export interface ArtifactMentionReference {
  version: 1;
  project_id: string;
  entry_id: string;
  name: string;
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ENTRY = /^[a-f0-9]{64}$/;
const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function artifactMentionReference(
  value: unknown,
): ArtifactMentionReference | undefined {
  if (!value || typeof value !== "object") return;
  const reference = value as ArtifactMentionReference;
  if (
    reference.version !== 1 ||
    !UUID.test(reference.project_id) ||
    !ENTRY.test(reference.entry_id) ||
    !NAME.test(reference.name)
  )
    return;
  return {
    version: 1,
    project_id: reference.project_id,
    entry_id: reference.entry_id,
    name: reference.name,
  };
}

export function serializeArtifactMention(
  reference: ArtifactMentionReference,
): string {
  const valid = artifactMentionReference(reference);
  if (!valid) throw Error("Invalid artifact mention reference");
  return `<span class="artifact-mention" data-artifact-reference="${encodeURIComponent(JSON.stringify(valid))}">@${valid.name}</span>`;
}

export function parseArtifactMention(
  markup: string,
): ArtifactMentionReference | undefined {
  const match = markup.match(
    /^<span class="artifact-mention" data-artifact-reference="([^"]{1,2048})">@([a-z0-9-]+)<\/span>$/,
  );
  if (!match) return;
  try {
    const reference = artifactMentionReference(
      JSON.parse(decodeURIComponent(match[1])),
    );
    return reference?.name === match[2] ? reference : undefined;
  } catch {
    return;
  }
}

export function extractArtifactMentions(
  markdown: string,
): ArtifactMentionReference[] {
  const references = new Map<string, ArtifactMentionReference>();
  for (const match of markdown.matchAll(
    /<span class="artifact-mention" data-artifact-reference="[^"]{1,2048}">@[a-z0-9-]+<\/span>/g,
  )) {
    const reference = parseArtifactMention(match[0]);
    if (reference)
      references.set(
        `${reference.project_id}/${reference.entry_id}`,
        reference,
      );
  }
  return [...references.values()];
}
