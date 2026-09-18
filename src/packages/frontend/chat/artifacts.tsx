/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { readArtifact, validateArtifactPublication } from "@cocalc/chat";
import type { ChatActions } from "./actions";
import { ArtifactCard } from "./artifact-card";
import { ReadonlyArtifactCards } from "./readonly-artifacts";
import { openArtifact } from "./open-artifact";

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
  return (
    <>
      {rows.map((row) => {
        try {
          const publication = validateArtifactPublication(row);
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
              syncdb={actions.syncdb}
              projectId={actions.store?.get("project_id")}
              open={
                actions.frameTreeActions && actions.frameId ? open : undefined
              }
            />
          );
        } catch {
          return (
            <div role="status" key={row?.sender_id}>
              Artifact unavailable
            </div>
          );
        }
      })}
    </>
  );
}
