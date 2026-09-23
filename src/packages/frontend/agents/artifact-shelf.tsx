import { Button } from "antd";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { artifactIdentity } from "./artifact-catalog-store";
import type { AgentSearchHit } from "./search-runner";

export const ARTIFACT_SHELF_LIMIT = 40;
export type ArtifactScope = "agent" | "all";

function artifactIcon(kind: string | undefined): IconName {
  switch (kind) {
    case "markdown":
      return "markdown";
    case "actions":
      return "bolt";
    case "github-pr":
      return "github";
    case "commit":
      return "git";
    default:
      return "file";
  }
}

interface Props {
  results: AgentSearchHit[];
  scope: ArtifactScope;
  hasActiveAgent: boolean;
  onScope: (scope: ArtifactScope) => void;
  onBrowse: () => void;
  onOpen: (hit: AgentSearchHit) => Promise<void>;
  pins: string[];
  onPin: (id: string, pinned: boolean) => void;
  opening: boolean;
  loading: boolean;
}

/** Metadata only: opening the shelf never resolves source files or previews. */
export function ArtifactShelf({
  results,
  scope,
  hasActiveAgent,
  onScope,
  onBrowse,
  onOpen,
  pins,
  onPin,
  opening,
  loading,
}: Props) {
  return (
    <KeyboardBoundary
      boundary="artifact-shelf"
      role="region"
      aria-label="Artifact shelf"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "4px 8px",
        minWidth: 0,
        maxWidth: "100%",
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
        padding: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          minWidth: 0,
          maxWidth: "100%",
          flex: "0 1 auto",
        }}
      >
        <strong>Artifacts</strong>
        <div
          role="group"
          aria-label="Artifact scope"
          style={{ display: "flex", flexWrap: "wrap", gap: 4, minWidth: 0 }}
        >
          <Button
            size="small"
            disabled={!hasActiveAgent}
            aria-pressed={scope === "agent"}
            onClick={() => onScope("agent")}
          >
            This agent
          </Button>
          <Button
            size="small"
            aria-pressed={scope === "all"}
            onClick={() => onScope("all")}
          >
            All agents
          </Button>
        </div>
        <Button size="small" onClick={onBrowse}>
          Browse all ({results.length})
        </Button>
      </div>
      <div
        role={results.length ? "list" : "status"}
        aria-label="Cached artifacts"
        style={{
          display: "flex",
          alignItems: "center",
          flex: "1 1 240px",
          minWidth: 0,
          overflowX: "auto",
          gap: 8,
          padding: "2px",
          maxWidth: "100%",
        }}
      >
        {results.slice(0, ARTIFACT_SHELF_LIMIT).map((result) => {
          const id = artifactIdentity(result);
          const title = result.hit.artifact_title || "Untitled artifact";
          const pinned = pins.includes(id);
          return (
            <div
              role="listitem"
              key={id}
              style={{
                display: "flex",
                alignItems: "center",
                flex: "0 0 auto",
                maxWidth: "100%",
                border: `1px solid ${UI_COLORS.border}`,
                borderRadius: 6,
              }}
            >
              <Tooltip
                trigger={["hover", "focus"]}
                title={`${title} · @${result.agent.name} · ${result.hit.artifact_kind ?? "artifact"}`}
              >
                <Button
                  type="text"
                  disabled={opening}
                  aria-label={`Open ${title} from ${result.agent.name}`}
                  onClick={() => void onOpen(result)}
                  icon={<Icon name={artifactIcon(result.hit.artifact_kind)} />}
                  style={{ minWidth: 0, maxWidth: 160 }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {title}
                  </span>
                </Button>
              </Tooltip>
              <Button
                type="text"
                aria-label={`${pinned ? "Unpin" : "Pin"} ${title}`}
                aria-pressed={pinned}
                onClick={() => onPin(id, !pinned)}
                icon={<Icon name={pinned ? "pushpin-filled" : "pushpin"} />}
              />
            </div>
          );
        })}
        {!results.length && (
          <span style={{ color: UI_COLORS.secondary, fontSize: 12 }}>
            {loading
              ? "Loading cached artifacts..."
              : "No cached artifacts in this scope."}
          </span>
        )}
      </div>
    </KeyboardBoundary>
  );
}
