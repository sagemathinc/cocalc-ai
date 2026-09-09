/** Typed Markdown artifacts in the existing Patchflow chat document. */
export const ARTIFACT_TEXT_LIMIT = 32 * 1024;
const DATE = "1970-01-01T00:00:00.000Z";

export interface ArtifactTarget {
  thread_id: string;
  artifact_id: string;
}

export interface ArtifactRecord extends ArtifactTarget {
  event: "chat-artifact";
  sender_id: string;
  date: string;
  schema_version: 1;
  kind: "markdown";
  title: string;
  input: string;
}

export interface ArtifactPublication extends ArtifactTarget {
  event: "chat-artifact-publication";
  sender_id: string;
  date: string;
  schema_version: 1;
  operation_id: string;
  message_id: string;
  snapshot: { title: string; markdown: string };
}

export interface ArtifactStore {
  get_one(key: object): unknown;
  set(row: object): unknown;
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw Error(`invalid artifact ${name}`);
  }
  return value;
}

function text(value: unknown, name: string, limit: number): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > limit
  ) {
    throw Error(`artifact ${name} must be a string of at most ${limit} bytes`);
  }
  return value;
}

export function artifactKey(target: ArtifactTarget) {
  return {
    event: "chat-artifact" as const,
    date: DATE,
    sender_id: `__artifact__:${id(target.artifact_id, "id")}`,
    thread_id: id(target.thread_id, "thread id"),
  };
}

export function artifactPublicationKey(
  target: ArtifactTarget,
  operation: string,
) {
  return {
    event: "chat-artifact-publication" as const,
    date: DATE,
    sender_id: `__artifact__:${id(target.artifact_id, "id")}:${id(operation, "operation id")}`,
    thread_id: id(target.thread_id, "thread id"),
  };
}

function plain(value: any): any {
  return value?.toJS instanceof Function ? value.toJS() : value;
}

export function validateArtifact(value: unknown): ArtifactRecord {
  const row = plain(value);
  if (
    row?.event !== "chat-artifact" ||
    row.schema_version !== 1 ||
    row.kind !== "markdown"
  ) {
    throw Error("unsupported or missing artifact");
  }
  const key = artifactKey(row);
  if (row.sender_id !== key.sender_id || row.date !== DATE)
    throw Error("invalid artifact key");
  return {
    ...key,
    artifact_id: row.artifact_id,
    schema_version: 1,
    kind: "markdown",
    title: text(row.title, "title", 256),
    input: text(row.input, "Markdown", ARTIFACT_TEXT_LIMIT),
  };
}

export function validateArtifactPublication(
  value: unknown,
): ArtifactPublication {
  const row = plain(value);
  if (row?.event !== "chat-artifact-publication" || row.schema_version !== 1) {
    throw Error("unsupported or missing artifact publication");
  }
  const key = artifactPublicationKey(row, row.operation_id);
  if (row.sender_id !== key.sender_id || row.date !== DATE)
    throw Error("invalid publication key");
  return {
    ...key,
    artifact_id: row.artifact_id,
    schema_version: 1,
    operation_id: row.operation_id,
    message_id: id(row.message_id, "message id"),
    snapshot: {
      title: text(row.snapshot?.title, "title", 256),
      markdown: text(row.snapshot?.markdown, "Markdown", ARTIFACT_TEXT_LIMIT),
    },
  };
}

// Exact content, not a collision-prone hash or a distributed CAS claim.
export function artifactBase(record: ArtifactRecord): string {
  return JSON.stringify([record.title, record.input]);
}

export function readArtifact(store: ArtifactStore, target: ArtifactTarget) {
  const artifact = validateArtifact(store.get_one(artifactKey(target)));
  return { artifact, base: artifactBase(artifact) };
}

export interface PublishArtifactInput extends ArtifactTarget {
  operation_id: string;
  message_id: string;
  title: string;
  markdown: string;
  /** Required for updates; obtained from readArtifact. */
  base?: string;
}

/** Synchronous local mutation; the caller commits, synchronizes and persists. */
export function publishArtifact(
  store: ArtifactStore,
  input: PublishArtifactInput,
) {
  const artifact = validateArtifact({
    ...artifactKey(input),
    artifact_id: input.artifact_id,
    schema_version: 1,
    kind: "markdown",
    title: input.title,
    input: input.markdown,
  });
  const publication = validateArtifactPublication({
    ...artifactPublicationKey(input, input.operation_id),
    artifact_id: input.artifact_id,
    schema_version: 1,
    operation_id: input.operation_id,
    message_id: input.message_id,
    snapshot: { title: artifact.title, markdown: artifact.input },
  });
  const previous = store.get_one(
    artifactPublicationKey(input, input.operation_id),
  );
  if (previous != null) {
    if (
      JSON.stringify(validateArtifactPublication(previous)) !==
      JSON.stringify(publication)
    ) {
      throw Error("artifact operation id already used for different content");
    }
    return { ...readArtifact(store, input), publication, replayed: true };
  }
  const current = store.get_one(artifactKey(input));
  if (
    current == null
      ? input.base !== undefined
      : input.base !== artifactBase(validateArtifact(current))
  ) {
    throw Error(
      "artifact changed or already exists; read the current artifact before updating",
    );
  }
  // No await between the base check and mutation. Unseen concurrent remote
  // edits still use Patchflow's input string merge, just like human edits.
  store.set(artifact);
  store.set(publication);
  return {
    artifact,
    base: artifactBase(artifact),
    publication,
    replayed: false,
  };
}
