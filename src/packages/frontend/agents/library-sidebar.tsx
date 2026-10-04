/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The workspace sidebar on the Library (sidebar navigation): pinned
// artifacts (the Library's pins, drag to reorder) and recent ones, from the
// same catalog the Library page keeps refreshed.

import { useSyncExternalStore } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, isIconName } from "@cocalc/frontend/components";
import {
  SidebarList,
  type SidebarListItem,
} from "@cocalc/frontend/components/sidebar-list";
import { blobImageUrl } from "@cocalc/frontend/components/theme-image-url";
import { useArtifactPins } from "@cocalc/frontend/chat/use-artifact-pins";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { useArtifactNames } from "./artifact-names";
import {
  artifactIdentity as identity,
  catalogResults,
  sharedArtifactCatalog,
} from "./artifact-catalog-store";
import type { AgentSearchHit } from "./search-runner";

const RECENT = 15;
const MATCHES = 50;
// In a sidebar section, which shows a few and links to the full page.
const SECTION_RECENT = 3;

export function LibrarySidebar({
  search,
  inSection = false,
  onlyCurrent = false,
  accountId,
  agents,
  onOpen,
  onAll,
  onNew,
}: {
  // From the sidebar's search box.
  search: string;
  // Shown as a sidebar section: fewer recent items and no list heading.
  inSection?: boolean;
  // Only the open item, for a collapsed sidebar section.
  onlyCurrent?: boolean;
  accountId: string;
  agents: NamedAgent[];
  onOpen: (hit: AgentSearchHit) => void;
  onAll: () => void;
  onNew?: () => void;
}) {
  const catalog = sharedArtifactCatalog(accountId, (opts) =>
    webapp_client.conat_client.hub.artifactCatalog.listProject(opts),
  );
  const metadata = useSyncExternalStore(catalog.subscribe, catalog.get);
  const pins = useArtifactPins();
  const { names } = useArtifactNames();
  const routeProject = useTypedRedux("page", "library_project_id");
  const routeEntry = useTypedRedux("page", "library_entry_id");
  // A named artifact opens by its name (/artifacts/<name>), which the route
  // holds in place of the project id; resolve it to mark the open artifact.
  const openAlias =
    routeEntry == null && routeProject
      ? names.find((alias) => alias.active && alias.name === routeProject)
      : undefined;
  const openProject = openAlias?.project_id ?? routeProject;
  const openEntry = openAlias?.entry_id ?? routeEntry;
  const results = catalogResults(metadata.entries, agents, {
    query: search,
    sort: "recent",
    pins: [],
    aliases: names,
  });
  const byId = new Map(results.map((hit) => [identity(hit), hit]));
  const entries = new Map(
    metadata.entries.map((entry) => [
      `${entry.project_id}/${entry.entry_id}`,
      entry,
    ]),
  );
  const pinned = pins.pins
    .map((id) => byId.get(id))
    .filter((hit): hit is AgentSearchHit => hit != null);
  const others = results.filter((hit) => !pins.pins.includes(identity(hit)));
  const limit = onlyCurrent
    ? Infinity
    : search.trim()
      ? MATCHES
      : inSection
        ? SECTION_RECENT
        : RECENT;

  const item = (hit: AgentSearchHit): SidebarListItem => {
    const appearance = entries.get(
      `${hit.agent.endpoint.project_id}/${hit.catalogEntryId}`,
    )?.item.appearance;
    const title = hit.hit.artifact_title || "Untitled artifact";
    return {
      id: identity(hit),
      title,
      tooltip: `${title} · @${hit.agent.name} · ${hit.hit.artifact_kind ?? ""}`,
      current:
        hit.agent.endpoint.project_id === openProject &&
        hit.catalogEntryId === openEntry,
      avatar: appearance?.image_blob ? (
        <img
          src={blobImageUrl(appearance.image_blob)}
          alt=""
          style={{ width: 26, height: 26, borderRadius: 6, objectFit: "cover" }}
        />
      ) : (
        <Icon
          name={isIconName(appearance?.icon) ? appearance.icon : "file"}
          style={{
            width: 26,
            fontSize: 18,
            textAlign: "center",
            color: appearance?.color ?? UI_COLORS.secondary,
          }}
        />
      ),
    };
  };

  return (
    <SidebarList
      showLabel={!inSection}
      onlyCurrent={onlyCurrent}
      label="Artifacts"
      itemLabel="artifact"
      newLabel="New Artifact"
      onNew={onNew}
      search={search}
      pinned={pinned.map(item)}
      recent={others.slice(0, limit).map(item)}
      more={Math.max(0, others.length - limit)}
      onOpen={(id) => {
        const hit = byId.get(id);
        if (hit) onOpen(hit);
      }}
      onPin={(id, pin) => pins.setPinned(id, pin)}
      onMovePin={(visible, id, index) => pins.move(visible, id, index)}
      onAll={onAll}
      emptyText={metadata.loading ? "Loading library..." : "No artifacts yet."}
    />
  );
}
