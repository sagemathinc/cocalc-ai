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

Only messages from the frame's own window count. The frame has an opaque
origin, so posts to it use "*"; the text is the saved file this user can
already read. Edits in the frame stay there: the file is not changed.
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
  const [text, setText] = useState<string>();
  const [error, setError] = useState("");
  const [frameError, setFrameError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const readyRef = useRef(false);
  const textRef = useRef<string | undefined>(undefined);
  textRef.current = text;
  const name = path.split("/").pop() ?? path;

  useEffect(() => {
    let cancelled = false;
    setError("");
    setLoading(true);
    void (async () => {
      try {
        const fs = actions?.fs();
        if (!fs) throw Error("Project filesystem unavailable");
        const stat = await fs.stat(path);
        if (stat.size > BOARD_PREVIEW_LIMIT)
          throw Error(
            `The board exceeds the ${BOARD_PREVIEW_LIMIT / 1024 / 1024} MiB preview limit. Open the file to see it.`,
          );
        const raw = await fs.readFile(path, "utf8");
        const content = typeof raw === "string" ? raw : raw.toString();
        if (!cancelled) setText(content);
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

  const post = () => {
    const target = frameRef.current?.contentWindow;
    const value = textRef.current;
    if (!target || !readyRef.current || value == null) return;
    setFrameError("");
    target.postMessage(
      { sagebrush: "board", version: 1, text: value, name },
      "*",
    );
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const data = event.data;
      if (data == null || typeof data !== "object" || data.version !== 1)
        return;
      if (data.sagebrush === "ready") {
        // Also after the frame reloads.
        readyRef.current = true;
        post();
      } else if (data.sagebrush === "error") {
        setFrameError(
          `${data.message ?? "The board could not be shown."}`.slice(0, 500),
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [name]);

  // A new saved text replaces the board shown.
  useEffect(() => {
    post();
  }, [text]);

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
      <iframe
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
      <div role="note" style={{ flexShrink: 0, marginTop: 6, fontSize: "85%" }}>
        Runs in Sagebrush, sandboxed. Changes made here are not saved to the
        file.
      </div>
    </KeyboardBoundary>
  );
}
