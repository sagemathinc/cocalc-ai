import type { ArtifactMentionReference } from "@cocalc/util/artifact-mentions";
import { serializeArtifactMention } from "@cocalc/util/artifact-mentions";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  ARTIFACT_NAMES_SETTING,
  readArtifactNames,
} from "@cocalc/frontend/agents/artifact-names";
import { openLibrary } from "@cocalc/frontend/agents/library-navigation";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { register } from "./register";
import type { RenderElementProps, SlateElement } from "./register";

export interface ArtifactMention extends SlateElement {
  type: "artifact-mention";
  reference: ArtifactMentionReference;
  isInline: true;
  isVoid: true;
}

export function createArtifactMention(
  reference: ArtifactMentionReference,
): ArtifactMention {
  return {
    type: "artifact-mention",
    reference,
    isInline: true,
    isVoid: true,
    children: [{ text: "" }],
  };
}

function ArtifactMentionElement({
  attributes,
  element,
  children,
}: RenderElementProps) {
  const settings = useTypedRedux("account", "other_settings");
  if (element.type !== "artifact-mention")
    throw Error("Expected artifact mention");
  const reference = element.reference;
  const name =
    readArtifactNames(settings?.get?.(ARTIFACT_NAMES_SETTING)).find(
      (item) =>
        item.active &&
        item.project_id === reference.project_id &&
        item.entry_id === reference.entry_id,
    )?.name ?? reference.name;
  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <button
          type="button"
          aria-label={`Open artifact @${name}`}
          title="Open this artifact in Library"
          onClick={() => openLibrary(reference.project_id, reference.entry_id)}
          style={{
            color: UI_COLORS.link,
            background: UI_COLORS.elevated,
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 3,
            font: "inherit",
            cursor: "pointer",
          }}
        >
          @{name}
        </button>
      </span>
      {children}
    </span>
  );
}

register({
  slateType: "artifact-mention",
  toSlate: ({ token }) => createArtifactMention(token.reference),
  fromSlate: ({ node }) => serializeArtifactMention(node.reference),
  Element: ArtifactMentionElement,
  StaticElement: ArtifactMentionElement,
});
