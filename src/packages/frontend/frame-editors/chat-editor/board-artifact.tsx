/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A Sagebrush board (.board.json) published as a file artifact, shown live: the
board and its code run in Sagebrush's /frame/board/ page, in a sandboxed frame
with an opaque origin.

The frame itself is kept by board-frame-host.ts, outside this component, and
laid over the placeholder rendered here. Maximizing the frame, changing the
workbench layout, switching editor tabs or scrolling a chat card away
remounts this component; with the same view key it takes over the same live
frame, so the board keeps its state, including the user's edits. Refresh
reads the file again into a new frame. The frame host also answers the
frame's protocol, once per frame.

Showing a board sends its complete text and name to the configured origin,
as the card says. Edits in the frame stay there: the file is not changed.
*/

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { Alert, Button, Space } from "antd";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { FileArtifactAction } from "./file-artifact";
import {
  BOARD_FRAME_SANDBOX,
  BOARD_PREVIEW_LIMIT,
} from "./board-artifact-frame";
import {
  attachBoardFrame,
  createBoardFrame,
  focusBoardFrame,
  getBoardFrame,
  type BoardFrame,
} from "./board-frame-host";

export default function BoardArtifact({
  path,
  frameUrl,
  viewKey,
  historical = false,
  onToolbarActions,
}: {
  path: string;
  frameUrl: string;
  // Which view this is (the artifact and the frame or card showing it): a
  // remount with the same key keeps the same live board.
  viewKey: string;
  historical?: boolean;
  onToolbarActions?: (actions: FileArtifactAction[]) => void;
}) {
  const compact = onToolbarActions !== undefined;
  const { actions } = useProjectContext();
  // Read through a ref: a new actions object must not reload the board.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const placeholderRef = useRef<HTMLDivElement>(null);
  const key = `${viewKey}\n${path}\n${frameUrl}`;
  const [frame, setFrame] = useState<BoardFrame | undefined>(() =>
    getBoardFrame(key),
  );
  const [error, setError] = useState("");
  const [frameError, setFrameError] = useState("");
  const [shownElsewhere, setShownElsewhere] = useState(false);
  const [loading, setLoading] = useState(false);
  // Bumped by Refresh. The first read happens only when no live frame
  // exists for this view.
  const [refresh, setRefresh] = useState(frame == null ? 1 : 0);
  // A read that found no project actions yet: read again once they come
  // (but not for every new actions object, which would replace the frame).
  const [waitingForActions, setWaitingForActions] = useState(false);
  const hasActions = actions != null;
  useEffect(() => {
    if (hasActions && waitingForActions) {
      setWaitingForActions(false);
      setRefresh((r) => r + 1);
    }
  }, [hasActions, waitingForActions]);
  const name = path.split("/").pop() ?? path;
  const site = new URL(frameUrl).host;

  useEffect(() => {
    if (refresh === 0) return;
    let cancelled = false;
    setError("");
    setFrameError("");
    setLoading(true);
    void (async () => {
      try {
        const fs = actionsRef.current?.fs();
        if (!fs) {
          if (!cancelled) setWaitingForActions(true);
          throw Error("Project filesystem unavailable");
        }
        const tooLarge = Error(
          `The board exceeds the ${BOARD_PREVIEW_LIMIT / 1024 / 1024} MiB preview limit. Open the file to see it.`,
        );
        const stat = await fs.stat(path);
        if (stat.size > BOARD_PREVIEW_LIMIT) throw tooLarge;
        // The file can grow between stat and read: check what was read.
        const raw = await fs.readFile(path);
        const bytes =
          typeof raw === "string"
            ? new TextEncoder().encode(raw)
            : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        if (bytes.byteLength > BOARD_PREVIEW_LIMIT) throw tooLarge;
        const text =
          typeof raw === "string" ? raw : new TextDecoder().decode(bytes);
        if (cancelled) return;
        setFrame(
          createBoardFrame({
            key,
            path,
            frameUrl,
            sandbox: BOARD_FRAME_SANDBOX,
            text,
            name,
            title: `Sagebrush board: ${name}`,
          }),
        );
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, refresh]);

  // Lay the live frame over the placeholder while this component shows it.
  useLayoutEffect(() => {
    const element = placeholderRef.current;
    if (frame == null || element == null) return;
    return attachBoardFrame(frame, element, (state) => {
      setFrameError(state.frameError);
      setShownElsewhere(!state.active);
    });
  }, [frame]);

  const openInProject = () => {
    void actions?.open_file({ path }).catch((err) => setError(String(err)));
  };
  const download = () => {
    void actions
      ?.download_file({ path, log: true })
      .catch((err) => setError(String(err)));
  };
  useEffect(() => {
    onToolbarActions?.([
      {
        key: "open",
        label: "Open in project",
        icon: "external-link",
        disabled: !actions,
        primary: true,
        onClick: openInProject,
      },
      {
        key: "download",
        label: "Download",
        icon: "download",
        disabled: !actions,
        onClick: download,
      },
      {
        key: "refresh",
        label: "Refresh",
        icon: "refresh",
        disabled: loading,
        onClick: () => setRefresh((n) => n + 1),
      },
    ]);
  }, [onToolbarActions, actions, path, loading]);

  const toolbar: React.ReactElement | null = compact ? null : (
    <Space wrap style={{ flexShrink: 0, marginBottom: 8 }}>
      <Button disabled={!actions} onClick={openInProject}>
        Open in project
      </Button>
      <Button disabled={!actions} onClick={download}>
        Download
      </Button>
      <Button disabled={loading} onClick={() => setRefresh((n) => n + 1)}>
        Refresh
      </Button>
      <span role="status">
        {loading ? "Loading current saved board..." : "Current saved board"}
      </span>
    </Space>
  );

  return (
    <KeyboardBoundary
      className="smc-vfill"
      style={{
        minHeight: 0,
        padding: 12,
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      {toolbar}
      {historical && (
        <div role="note">
          Published file reference; the board shown is the current saved file,
          not a historical snapshot.
        </div>
      )}
      {error && <Alert type="warning" title={error} />}
      {frameError && (
        <Alert
          type="error"
          title="Sagebrush could not show this board"
          description={frameError}
        />
      )}
      {frame && (
        // Keyboard: the frame itself lives at the end of the page; this
        // placeholder is its focus proxy, and the marks around it are where
        // focus returns when it leaves the frame (board-frame-host.ts).
        <span tabIndex={-1} data-board-frame-enter="" />
      )}
      {frame && (
        <div
          ref={placeholderRef}
          data-board-frame-placeholder=""
          tabIndex={0}
          role="group"
          aria-label={`Sagebrush board: ${name}`}
          onFocus={(e) => {
            if (e.target === e.currentTarget) focusBoardFrame(frame);
          }}
          style={{
            flex: "1 1 0",
            minHeight: 420,
            width: "100%",
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {shownElsewhere && (
            <span role="note">This board is shown in another view.</span>
          )}
        </div>
      )}
      {frame && <span tabIndex={-1} data-board-frame-exit="" />}
      <div role="note" style={{ flexShrink: 0, marginTop: 6, fontSize: "85%" }}>
        Runs on {site} in a sandboxed frame: showing it sends {site} this
        file&apos;s complete text and name. Changes made there are not saved to
        the file.
      </div>
    </KeyboardBoundary>
  );
}
