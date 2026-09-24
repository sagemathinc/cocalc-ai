/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useId, useState } from "react";
import { readArtifact, validateArtifactPublication } from "@cocalc/chat";
import type { ArtifactPublication } from "@cocalc/chat";
import type { ChatActions } from "./actions";
import { ArtifactCard } from "./artifact-card";
import { ReadonlyArtifactCards } from "./readonly-artifacts";
import { openArtifact } from "./open-artifact";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { Button } from "antd";

export function latestArtifactPublications(
  rows: unknown[],
): ArtifactPublication[] {
  const latest = new Map<string, ArtifactPublication>();
  for (const row of rows) {
    try {
      const publication = validateArtifactPublication(row);
      const previous = latest.get(publication.artifact_id);
      if (
        !previous ||
        !previous.published_at ||
        (publication.published_at ?? "") >= previous.published_at
      ) {
        latest.delete(publication.artifact_id);
        latest.set(publication.artifact_id, publication);
      }
    } catch {
      // An invalid publication must not hide the other artifacts in the turn.
    }
  }
  return [...latest.values()]
    .reverse()
    .sort(
      (left, right) =>
        Number(!!right.snapshot.actions) - Number(!!left.snapshot.actions),
    );
}

export function artifactSyncdbReady(syncdb: any): boolean {
  return !!syncdb && (!syncdb.get_state || syncdb.get_state() === "ready");
}

export function useArtifactChanges(syncdb: any) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!syncdb) return;
    const changed = () => setVersion((n) => n + 1);
    syncdb.on("change", changed);
    syncdb.on("ready", changed);
    syncdb.on("closed", changed);
    changed();
    return () => {
      syncdb.removeListener("change", changed);
      syncdb.removeListener("ready", changed);
      syncdb.removeListener("closed", changed);
    };
  }, [syncdb]);
  return version;
}

export function ArtifactCards({
  actions,
  threadId,
  messageId,
}: {
  actions?: ChatActions;
  threadId?: string;
  messageId?: string;
}) {
  useArtifactChanges(actions?.syncdb);
  const [expanded, setExpanded] = useState(false);
  const expandedId = useId();
  if (!actions?.syncdb)
    return <ReadonlyArtifactCards threadId={threadId} messageId={messageId} />;
  if (!threadId || !messageId) return null;
  if (!artifactSyncdbReady(actions.syncdb))
    return <div role="status">Loading artifacts...</div>;
  const found = actions.syncdb.get({
    event: "chat-artifact-publication",
    thread_id: threadId,
    message_id: messageId,
  });
  const rows = found?.toJS?.() ?? found ?? [];
  const publications = latestArtifactPublications(rows);
  const renderCard = (publication: ArtifactPublication, compact: boolean) => {
    let current;
    try {
      current = readArtifact(actions.syncdb!, publication).artifact;
    } catch {
      /* Historical publication only. */
    }
    const open = (version?: string) => {
      openArtifact(actions, publication, version);
    };
    return (
      <ArtifactCard
        key={publication.operation_id}
        publication={publication}
        current={current}
        compact={compact}
        syncdb={actions.syncdb}
        projectId={actions.store?.get("project_id")}
        chatPath={actions.store?.get("path")}
        open={actions.frameTreeActions && actions.frameId ? open : undefined}
      />
    );
  };
  if (!publications.length) return null;
  return (
    <div aria-label="Message artifacts" style={{ marginTop: 6 }}>
      <div
        role="group"
        aria-label="Recent message artifacts"
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 6,
          minWidth: 0,
          overflowX: "auto",
        }}
      >
        {publications.slice(0, 2).map((publication) => (
          <div
            key={publication.artifact_id}
            style={{ flex: "0 0 auto", width: 220, maxWidth: "80%" }}
          >
            {renderCard(publication, true)}
          </div>
        ))}
      </div>
      {publications.length > 2 && (
        <div style={{ marginTop: 4, textAlign: "right" }}>
          <Button
            type="link"
            aria-expanded={expanded}
            aria-controls={expandedId}
            onClick={() => setExpanded((value) => !value)}
            style={{ color: UI_COLORS.link, paddingInline: 0 }}
          >
            {expanded
              ? "Hide artifacts"
              : `+${publications.length - 2} artifacts`}
          </Button>
          {expanded && (
            <div
              id={expandedId}
              role="region"
              aria-label="All message artifacts"
              style={{
                maxHeight: "min(50vh, 480px)",
                overflowY: "auto",
                textAlign: "left",
              }}
            >
              {publications.map((publication) =>
                renderCard(publication, false),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
