import { createHash } from "node:crypto";
import type { PublishArtifactInput } from "@cocalc/chat";

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

/** Deterministic retries; updates must carry the base the caller reviewed. */
export function prepareArtifactPublication({
  payload,
  threadId,
  messageId,
  artifactId,
}: {
  payload: Partial<PublishArtifactInput>;
  threadId: string;
  messageId: string;
  artifactId?: string;
}): PublishArtifactInput {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw Error("Expected a publication object");
  for (const key of Object.keys(payload))
    if (
      ![
        "title",
        "markdown",
        "file",
        "actions",
        "github_pr",
        "commit",
        "theme",
        "base",
      ].includes(key)
    )
      throw Error(`Unexpected publication field: ${key}`);
  if (!payload.title?.trim()) throw Error("A title is required");
  if (
    artifactId ? typeof payload.base !== "string" : payload.base !== undefined
  )
    throw Error(
      "Updates require --update and the base from artifact read; new publications must omit base",
    );
  const content = {
    ...payload,
    markdown: payload.markdown ?? "",
    thread_id: threadId,
    message_id: messageId,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical({ ...content, artifact_id: artifactId })))
    .digest("hex");
  return {
    ...content,
    title: payload.title,
    artifact_id: artifactId ?? `artifact-${digest.slice(0, 24)}`,
    operation_id: `publish-${digest}`,
  };
}
