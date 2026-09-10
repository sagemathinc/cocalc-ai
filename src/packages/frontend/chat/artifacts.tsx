/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Button, Space } from "antd";
import { validateArtifactPublication } from "@cocalc/chat";
import type { ChatActions } from "./actions";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { ReadonlyArtifactCards } from "./readonly-artifacts";

export function useArtifactChanges(syncdb: any) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!syncdb) return;
    const changed = () => setVersion((n) => n + 1);
    syncdb.on("change", changed);
    changed();
    return () => {
      syncdb.removeListener("change", changed);
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
          const open = (version?: string) => {
            const frames = actions.frameTreeActions;
            const existing = frames
              ?.get_frame_ids_in_order()
              .find(
                (id) =>
                  frames._get_frame_data(id, "artifact") ===
                    publication.artifact_id &&
                  frames._get_frame_data(id, "thread") === threadId &&
                  frames._get_frame_data(id, "origin") === actions.frameId &&
                  (version === undefined ||
                    frames._get_frame_data(id, "version") === version),
              );
            if (existing) {
              frames?.set_active_id(existing);
              if (window.innerWidth < 768) frames?.set_frame_full(existing);
              return;
            }
            const opened = frames?.split_frame(
              "col",
              actions.frameId,
              "workbench",
              {
                "data-artifact": publication.artifact_id,
                "data-thread": threadId,
                "data-origin": actions.frameId,
                "data-publication": publication.operation_id,
                ...(version === undefined ? {} : { "data-version": version }),
              },
            );
            if (opened && window.innerWidth < 768)
              frames?.set_frame_full(opened);
          };
          return (
            <div
              key={publication.operation_id}
              style={{
                border: `1px solid ${UI_COLORS.border}`,
                borderRadius: 6,
                padding: 10,
                marginTop: 8,
                background: UI_COLORS.surface,
                color: UI_COLORS.text,
              }}
            >
              <Space wrap>
                <strong>{publication.snapshot.title}</strong>
                {publication.snapshot.github_pr && (
                  <span>
                    #{publication.snapshot.github_pr.number} ·{" "}
                    {publication.snapshot.github_pr.state} · Checks:{" "}
                    {publication.snapshot.github_pr.checks}
                  </span>
                )}
                <Button
                  size="small"
                  disabled={!actions.frameTreeActions || !actions.frameId}
                  onClick={(event) => {
                    event.stopPropagation();
                    open();
                  }}
                >
                  Open artifact
                </Button>
                <Button
                  size="small"
                  type="text"
                  disabled={!actions.frameTreeActions || !actions.frameId}
                  onClick={(event) => {
                    event.stopPropagation();
                    open(publication.operation_id);
                  }}
                >
                  {publication.snapshot.file
                    ? "Published reference"
                    : "Published version"}
                </Button>
              </Space>
              <div
                style={{
                  maxHeight: 60,
                  overflow: "hidden",
                  whiteSpace: "pre-wrap",
                  marginTop: 6,
                }}
              >
                {publication.snapshot.file?.path ??
                  publication.snapshot.markdown.slice(0, 240)}
              </div>
            </div>
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
