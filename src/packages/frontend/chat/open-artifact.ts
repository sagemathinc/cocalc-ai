import type { ArtifactPublication } from "@cocalc/chat";
import type { ChatActions } from "./actions";
import { openResult } from "./open-result";
import type { ArtifactSource } from "./open-result";

export function openArtifact(
  actions: ChatActions,
  publication: ArtifactPublication,
  version?: string,
  source?: ArtifactSource,
) {
  openResult(actions, { kind: "artifact", publication, version, source });
}
