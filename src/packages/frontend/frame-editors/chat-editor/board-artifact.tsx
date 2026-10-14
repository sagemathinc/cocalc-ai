/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A Sagebrush board (.board.json) published as a file artifact, shown live: the
board and its code run in Sagebrush's /frame/board/ page, in a sandboxed frame
with an opaque origin. The protocol (Sagebrush's design/frame.md):

- the frame, when it listens:  { sagebrush: "ready", version: 1 }
- this page:                   { sagebrush: "board", version: 1, text, name }
- the frame, for a bad text:   { sagebrush: "error", version: 1, message }

Only messages from the frame's own window count. That window object outlives
navigation: if the frame's document were replaced, the new document would
pass the same test. So the board is posted once per frame element, in answer
to its first "ready", and the frame is mounted only after the text has been
read; Refresh reads the file again and mounts a new frame. A later document in
the same frame gets nothing.

The frame has an opaque origin, so posts to it use "*". Showing a board sends
its complete text and name to the configured origin, as the card says. Edits
in the frame stay there: the file is not changed.
*/

import { useEffect, useRef, useState } from "react";
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

export default function BoardArtifact({
  path,
  frameUrl,
  historical = false,
  onToolbarActions,
}: {
  path: string;
  frameUrl: string;
  historical?: boolean;
  onToolbarActions?: (actions: FileArtifactAction[]) => void;
}) {
  const compact = onToolbarActions !== undefined;
  const { actions } = useProjectContext();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The text read for one frame: `id` is that frame's key.
  const [board, setBoard] = useState<{ id: number; text: string }>();
  const [error, setError] = useState("");
  const [frameError, setFrameError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const boardRef = useRef(board);
  boardRef.current = board;
  // The frame (by key) that has been sent its board.
  const answeredRef = useRef<number | undefined>(undefined);
  const name = path.split("/").pop() ?? path;
  const site = new URL(frameUrl).host;

  useEffect(() => {
    let cancelled = false;
    setError("");
    setFrameError("");
    setBoard(undefined);
    setLoading(true);
    void (async () => {
      try {
        const fs = actions?.fs();
        if (!fs) throw Error("Project filesystem unavailable");
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
        if (!cancelled) setBoard({ id: refresh, text });
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, path, refresh]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      const current = boardRef.current;
      if (!frame || !current || event.source !== frame) return;
      const data = event.data;
      if (data == null || typeof data !== "object" || data.version !== 1)
        return;
      if (data.sagebrush === "ready") {
        // Only the frame's first document, the one its src loaded.
        if (answeredRef.current === current.id) return;
        answeredRef.current = current.id;
        frame.postMessage(
          { sagebrush: "board", version: 1, text: current.text, name },
          "*",
        );
      } else if (
        data.sagebrush === "error" &&
        answeredRef.current === current.id
      ) {
        setFrameError(
          `${data.message ?? "The board could not be shown."}`.slice(0, 500),
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [name]);

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
      {board && (
        <iframe
          key={board.id}
          ref={frameRef}
          src={frameUrl}
          sandbox={BOARD_FRAME_SANDBOX}
          title={`Sagebrush board: ${name}`}
          style={{
            flex: "1 1 0",
            minHeight: 420,
            width: "100%",
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 4,
          }}
        />
      )}
      <div role="note" style={{ flexShrink: 0, marginTop: 6, fontSize: "85%" }}>
        Runs on {site} in a sandboxed frame: showing it sends {site} this
        file&apos;s complete text and name. Changes made there are not saved to
        the file.
      </div>
    </KeyboardBoundary>
  );
}
