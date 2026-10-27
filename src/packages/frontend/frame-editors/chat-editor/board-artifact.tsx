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

The card also asks the board's host to open the board (boardOpen; bounded
history plan H1b-4). While the host does not edit boards (ENOSYS), or when
the call fails, the card is exactly the saved-file view.  If the board's edit
history cannot be loaded, the card says why and offers ways to the board's
content that do not depend on it (open as text, download, restore, retry,
the docs page); if the host rebuilt it from the file, the card tells the
user once per history epoch.  The saved-file view below does not depend on
the history either.
*/

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { Alert, Button, Space } from "antd";
import type { BoardOpenResult } from "@cocalc/conat/files/fs";
import { alert_message } from "@cocalc/frontend/alerts";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  get_local_storage,
  set_local_storage,
} from "@cocalc/frontend/misc/local-storage";
import {
  boardHistoryView,
  takeRebuiltNotice,
  type BoardHistoryLink,
  type BoardHistoryView,
} from "@cocalc/frontend/project/board-history";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { download_href } from "@cocalc/frontend/project/utils";
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
  beginBoardLoad,
  boardLoadFailed,
  getBoardFrame,
  isBoardFrameLive,
  isLatestBoardLoad,
  nextBoardFrame,
  onBoardFrameCreated,
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
  const { actions, project_id } = useProjectContext();
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
  // A Refresh failed while a board was shown: it stays, labelled as the board
  // as last read, not the current saved file, until a read succeeds.
  const [stale, setStale] = useState(false);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => setStale(false), [frame]);
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
  // What the board's host answered, if it edits boards (H1b-4).
  const [history, setHistory] = useState<BoardHistoryView>();
  const name = path.split("/").pop() ?? path;
  const site = new URL(frameUrl).host;

  useEffect(() => {
    if (refresh === 0) return;
    let cancelled = false;
    setError("");
    setFrameError("");
    setLoading(true);
    const generation = beginBoardLoad(key);
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
        if (!isLatestBoardLoad(key, generation)) {
          // A newer read of this view (in another place, or a newer
          // Refresh) makes the frame: this one adopts it, never replaces it.
          const newest = await nextBoardFrame(key);
          if (cancelled) return;
          if (newest == null) {
            // That read failed or was abandoned: read it here instead.
            setRefresh((r) => r + 1);
            return;
          }
          setFrame(newest);
          return;
        }
        setFrame(
          createBoardFrame({
            key,
            path,
            frameUrl,
            sandbox: BOARD_FRAME_SANDBOX,
            text,
            name,
            title: `Sagebrush board: ${name}`,
            generation,
          }),
        );
      } catch (err) {
        boardLoadFailed(key, generation);
        if (!cancelled && !isLatestBoardLoad(key, generation)) {
          // Superseded: the newest read's frame, if it makes one, is this
          // view's too; only if it fails as well is this error shown.
          const newest = await nextBoardFrame(key);
          if (cancelled) return;
          if (newest != null) {
            setFrame(newest);
            return;
          }
        }
        if (!cancelled) {
          setError(String(err));
          setStale(frameRef.current != null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // An unfinished newest read is abandoned: whoever waits for it reads
      // the board themselves.
      boardLoadFailed(key, generation);
    };
  }, [key, refresh]);

  // A frame any place's read makes for the view is this card's too: with
  // none (its own read failed, say) it shows it, and with an older one (kept
  // after its own Refresh failed) it drops the error and the stale label,
  // since what it shows is now the newest read.
  useEffect(() => {
    return onBoardFrameCreated(key, (made) => {
      setError("");
      setStale(false);
      setLoading(false);
      setFrame(made);
    });
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    setHistory(undefined);
    const fs: any = actions?.fs();
    if (typeof fs?.boardOpen !== "function") return;
    void (async () => {
      let result: BoardOpenResult;
      try {
        result = await fs.boardOpen(path);
      } catch {
        // ENOSYS (the host does not edit boards) or any failure: the
        // saved-file view, as always
        return;
      }
      if (cancelled) return;
      const notice = takeRebuiltNotice({
        project_id,
        result,
        seen: { get: get_local_storage, set: set_local_storage },
      });
      if (notice) {
        alert_message({
          type: "info",
          title: "Board rebuilt from its saved file",
          message: notice,
          block: true,
        });
      }
      setHistory(
        boardHistoryView({
          project_id,
          result,
          downloadHref: (p, f) => download_href(p, f),
          basePath: appBasePath,
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, project_id, path, refresh]);

  const historyLink = (link: BoardHistoryLink) => {
    switch (link.action) {
      case "download":
        return (
          <Button key={link.action} href={link.href} target="_blank">
            {link.label}
          </Button>
        );
      case "open-as-text":
        return (
          <Button
            key={link.action}
            disabled={!actions}
            onClick={() =>
              void actions
                ?.open_file({ path: link.open!.path, ext: link.open!.ext })
                .catch((err) => setError(String(err)))
            }
          >
            {link.label}
          </Button>
        );
      case "restore":
        // how: the docs page (snapshots, TimeTravel)
        return (
          <Button key={link.action} href={history?.docsHref} target="_blank">
            {link.label}
          </Button>
        );
      case "retry":
        return (
          <Button
            key={link.action}
            disabled={loading}
            onClick={() => setRefresh((n) => n + 1)}
          >
            {link.label}
          </Button>
        );
    }
  };

  // Lay the live frame over the placeholder while this component shows it.
  useLayoutEffect(() => {
    const element = placeholderRef.current;
    if (frame == null || element == null) return;
    // A frame dropped before this card could attach it (claimed frames are
    // kept, but never show a blank card): read the board again.
    if (!isBoardFrameLive(frame)) {
      setFrame(undefined);
      setRefresh((r) => r + 1);
      return;
    }
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
        {loading
          ? "Loading current saved board..."
          : stale
            ? "Refresh failed: the board as last read, which may not be the current saved file"
            : "Current saved board"}
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
          Published file reference; the board shown is{" "}
          {stale
            ? "the file as last read (Refresh failed)"
            : "the current saved file"}
          , not a historical snapshot.
        </div>
      )}
      {history && (
        <Alert
          type="error"
          role="alert"
          aria-label="Ways to this board"
          title={history.title}
          description={
            <>
              {history.message && <div>{history.message}</div>}
              <Space wrap style={{ marginTop: 8 }}>
                {history.links.map(historyLink)}
                <a href={history.docsHref} target="_blank" rel="noreferrer">
                  What to do when a board&apos;s history can&apos;t be loaded
                </a>
              </Space>
            </>
          }
          style={{ flexShrink: 0, marginBottom: 8 }}
        />
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
          // Only the view that shows the frame is its focus proxy.
          tabIndex={shownElsewhere ? -1 : 0}
          role="group"
          aria-label={`Sagebrush board: ${name}`}
          onFocus={(e) => {
            if (e.target === e.currentTarget && !shownElsewhere) {
              focusBoardFrame(frame);
            }
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
