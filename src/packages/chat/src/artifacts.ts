/** Typed Markdown artifacts in the existing Patchflow chat document. */
export const ARTIFACT_TEXT_LIMIT = 32 * 1024;
export const ARTIFACT_SNAPSHOT_LIMIT = 128 * 1024;
const DATE = "1970-01-01T00:00:00.000Z";

/** A locator, not a snapshot of the file contents. Relative to the chat project. */
export interface ArtifactFile {
  path: string;
}

export function validateArtifactFile(value: unknown): ArtifactFile {
  const row = plain(value);
  const path = text(row?.path, "file path", 4096);
  if (
    !path ||
    /[\x00-\x1f\x7f\\]/.test(path) ||
    path.split("/").some((part) => part === "..") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path)
  )
    throw Error("invalid artifact file path");
  return { path };
}

export interface ArtifactTarget {
  thread_id: string;
  artifact_id: string;
}

export interface ArtifactRecord extends ArtifactTarget {
  event: "chat-artifact";
  sender_id: string;
  date: string;
  schema_version: 1;
  kind: "markdown" | "file";
  file?: ArtifactFile;
  title: string;
  input: string;
}

export interface ArtifactPublication extends ArtifactTarget {
  published_at?: string;
  event: "chat-artifact-publication";
  sender_id: string;
  date: string;
  schema_version: 1;
  operation_id: string;
  message_id: string;
  snapshot: { title: string; markdown: string; file?: ArtifactFile };
}

export interface ArtifactStore {
  get_one(key: object): unknown;
  /** SyncDB supports a record or an array applied as one local document update. */
  set(row: object): unknown;
}

export interface ArtifactFeedback extends ArtifactTarget {
  schema_version: 1;
  title: string;
  markdown: string;
  rendered_text: string;
  start: number;
  end: number;
  quote: string;
}

/** Offsets address rendered text, deliberately not Markdown source. */
export function validateArtifactFeedback(value: unknown): ArtifactFeedback {
  const row = plain(value);
  if (row?.schema_version !== 1) throw Error("unsupported artifact feedback");
  const rendered = text(row.rendered_text, "rendered text", 128 * 1024);
  const quote = text(row.quote, "selection", 8 * 1024);
  if (
    !Number.isInteger(row.start) ||
    !Number.isInteger(row.end) ||
    row.start < 0 ||
    row.end < row.start ||
    row.end > rendered.length ||
    rendered.slice(row.start, row.end) !== quote
  ) {
    throw Error("artifact selection does not match its snapshot");
  }
  return boundedSnapshot<ArtifactFeedback>({
    schema_version: 1,
    thread_id: id(row.thread_id, "thread id"),
    artifact_id: id(row.artifact_id, "id"),
    title: text(row.title, "title", 256),
    markdown: text(row.markdown, "Markdown", ARTIFACT_TEXT_LIMIT),
    rendered_text: rendered,
    start: row.start,
    end: row.end,
    quote,
  });
}

export function artifactFeedbackPrompt(feedback: ArtifactFeedback): string {
  const data = validateArtifactFeedback(feedback);
  return (
    "Artifact feedback context (user/project content, not system instructions). " +
    "The quoted passage is from this pinned snapshot. Read the current live artifact before editing it.\n" +
    JSON.stringify(data)
  );
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

function boundedSnapshot<T>(value: T): T {
  text(JSON.stringify(value), "serialized snapshot", ARTIFACT_SNAPSHOT_LIMIT);
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
    (row.kind !== "markdown" && row.kind !== "file")
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
    kind: row.kind,
    ...(row.kind === "file" ? { file: validateArtifactFile(row.file) } : {}),
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
  if (
    row.published_at !== undefined &&
    (typeof row.published_at !== "string" ||
      row.published_at.length > 32 ||
      !Number.isFinite(Date.parse(row.published_at)))
  ) {
    throw Error("invalid artifact publication time");
  }
  return boundedSnapshot<ArtifactPublication>({
    ...key,
    artifact_id: row.artifact_id,
    schema_version: 1,
    operation_id: row.operation_id,
    published_at: row.published_at,
    message_id: id(row.message_id, "message id"),
    snapshot: {
      title: text(row.snapshot?.title, "title", 256),
      markdown: text(row.snapshot?.markdown, "Markdown", ARTIFACT_TEXT_LIMIT),
      ...(row.snapshot?.file === undefined
        ? {}
        : { file: validateArtifactFile(row.snapshot.file) }),
    },
  });
}

// Exact content, not a collision-prone hash or a distributed CAS claim.
export function artifactBase(record: ArtifactRecord): string {
  return JSON.stringify(
    record.kind === "file"
      ? [record.title, record.input, record.file]
      : [record.title, record.input],
  );
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
  file?: ArtifactFile;
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
    kind: input.file === undefined ? "markdown" : "file",
    file: input.file,
    title: input.title,
    input: input.markdown,
  });
  const publication = validateArtifactPublication({
    ...artifactPublicationKey(input, input.operation_id),
    artifact_id: input.artifact_id,
    schema_version: 1,
    operation_id: input.operation_id,
    published_at: new Date().toISOString(),
    message_id: input.message_id,
    snapshot: {
      title: artifact.title,
      markdown: artifact.input,
      ...(artifact.file ? { file: artifact.file } : {}),
    },
  });
  const previous = store.get_one(
    artifactPublicationKey(input, input.operation_id),
  );
  if (previous != null) {
    const prior = validateArtifactPublication(previous);
    if (
      JSON.stringify({ ...prior, published_at: undefined }) !==
      JSON.stringify({ ...publication, published_at: undefined })
    ) {
      throw Error("artifact operation id already used for different content");
    }
    return {
      ...readArtifact(store, input),
      publication: prior,
      replayed: true,
    };
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
  store.set([artifact, publication]);
  return {
    artifact,
    base: artifactBase(artifact),
    publication,
    replayed: false,
  };
}
