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

Answers (Sagebrush's web/board-host-protocol.md), only where the card is
given a way to deliver them: the frame is loaded with a fresh nonce in its
fragment. The first "ready" carrying it, from a frame that has loaded one
document, gets the board with one end of a new MessageChannel, and the
user's submissions arrive only on that port (board-answers-channel.ts). A
second load closes the channel. A frame without the nonce gets the board
with no port, and so shows no Submit.

Where the site checks answers with a model (board_decide_enabled), the same
port also takes the frame's "decide" requests, sent only to the hub with the
board this card posted: its path, revision and the SHA-256 of its text
(board-decide-card.ts, computed only then, so showing a board never needs
it). They go to no agent.

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
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { boardPostedName } from "@cocalc/util/sagebrush-board";
import type { FileArtifactAction } from "./file-artifact";
import {
  BOARD_FRAME_SANDBOX,
  BOARD_PREVIEW_LIMIT,
} from "./board-artifact-frame";
import {
  BoardAnswersRefusal,
  openAnswersChannel,
  type DeliverBoardAnswers,
} from "./board-answers-channel";
import { boardDecider } from "./board-decide-card";

/** A fresh nonce for one frame (a version 4 UUID). From
 * crypto.getRandomValues, which every origin has: randomUUID is missing on a
 * plain-http site (cocalc-star on a LAN), where a board must still show
 * (Codex on #1134). */
// Reads of a board that a publication overtook, before giving up.
const MAX_READ_ATTEMPTS = 3;

function frameNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export default function BoardArtifact({
  path,
  frameUrl,
  historical = false,
  onToolbarActions,
  deliverAnswers,
  revision,
}: {
  path: string;
  frameUrl: string;
  historical?: boolean;
  onToolbarActions?: (actions: FileArtifactAction[]) => void;
  /** Given only where the user may answer the board's questions: then the
   * frame gets a nonce and its first document a port (Submit). */
  deliverAnswers?: DeliverBoardAnswers;
  /** The artifact's current revision, posted with the board. */
  revision?: string | null;
}) {
  const compact = onToolbarActions !== undefined;
  const { actions, project_id } = useProjectContext();
  const decideEnabled =
    useTypedRedux("customize", "board_decide_enabled") === true;
  const decideEnabledRef = useRef(decideEnabled);
  decideEnabledRef.current = decideEnabled;
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The text read (one load of the file), with the project and path it was
  // read from. A read is the identity everything after it uses: the frame
  // mounted for it, the name posted, and what its port decides and
  // delivers for. A new project or path is a new read, so a new frame, a
  // fresh nonce and the old port closed: the same mechanism as Refresh
  // (Codex on #1134).
  const [board, setBoard] = useState<{
    id: number;
    text: string;
    revision: string | null;
    project_id?: string;
    path: string;
  }>();
  // Whether this view may answer the board's questions.
  const canAnswer = deliverAnswers != null;
  // One frame: `id` is its key, `nonce` the secret in its address that only
  // the document it loads first has, `canAnswer` what it was mounted with.
  // A new board read, or the capability coming or going, is a new frame: a
  // fresh document, a fresh nonce, the old one's port closed. So a frame
  // mounted to answer never keeps a port once answering is off (a
  // historical view, or write access lost), and one mounted without never
  // gets one (Codex on #1134).
  const [mount, setMount] = useState<{
    id: number;
    nonce: string;
    canAnswer: boolean;
  }>();
  const mountSeq = useRef(0);
  const mountRef = useRef(mount);
  mountRef.current = mount;
  const [error, setError] = useState("");
  const [frameError, setFrameError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const boardRef = useRef(board);
  boardRef.current = board;
  // The frame (by key) that has been sent its board.
  const answeredRef = useRef<number | undefined>(undefined);
  // The frame (by key) and how many documents it has loaded: a second one
  // is a document this card didn't load, and gets no answers channel.
  const loadsRef = useRef<{ id?: number; loads: number }>({ loads: 0 });
  const channelRef = useRef<{ close: () => void } | undefined>(undefined);
  const deliverRef = useRef(deliverAnswers);
  deliverRef.current = deliverAnswers;
  const revisionRef = useRef(revision ?? null);
  revisionRef.current = revision ?? null;
  // The card's current project and path, for the check at each call.
  const identityRef = useRef({ project_id, path });
  identityRef.current = { project_id, path };
  const closeChannel = () => {
    channelRef.current?.close();
    channelRef.current = undefined;
  };
  const name = boardPostedName(path);
  const site = new URL(frameUrl).host;

  useEffect(() => {
    let cancelled = false;
    // A port opened for the previous project or path ends now, before the
    // new read.
    closeChannel();
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
        // The read's identity is fixed when it starts: its project and path
        // (this effect's), and the artifact's revision then. A publication
        // that lands while the file is read could otherwise label these
        // bytes with the newer revision, so submissions against them would
        // look current (Codex on #1134): then the bytes are dropped and the
        // file is read again, under the new revision.
        let revision = revisionRef.current;
        let raw: string | Buffer;
        for (let attempt = 1; ; attempt++) {
          revision = revisionRef.current;
          // The file service caps the read on the opened file, so a board
          // that grows while it is read is refused there, not buffered here.
          try {
            raw = await fs.readRegularFile(path, {
              maxBytes: BOARD_PREVIEW_LIMIT,
            });
          } catch (err) {
            if (err?.code === "EFBIG") throw tooLarge;
            throw err;
          }
          if (cancelled) return;
          if (revisionRef.current === revision) break;
          if (attempt >= MAX_READ_ATTEMPTS) {
            throw Error(
              "The board kept changing while it was read. Refresh to try again.",
            );
          }
        }
        const bytes =
          typeof raw === "string"
            ? new TextEncoder().encode(raw)
            : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        if (bytes.byteLength > BOARD_PREVIEW_LIMIT) throw tooLarge;
        const text =
          typeof raw === "string" ? raw : new TextDecoder().decode(bytes);
        if (!cancelled)
          setBoard({
            id: refresh,
            text,
            revision,
            project_id,
            path,
          });
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, project_id, path, refresh]);

  useEffect(() => {
    closeChannel();
    setMount(
      board
        ? { id: ++mountSeq.current, nonce: frameNonce(), canAnswer }
        : undefined,
    );
  }, [board, canAnswer]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      const current = boardRef.current;
      const mounted = mountRef.current;
      if (!frame || !current || !mounted || event.source !== frame) return;
      const data = event.data;
      if (data == null || typeof data !== "object" || data.version !== 1)
        return;
      if (data.sagebrush === "ready") {
        // Only the frame's first document, the one its src loaded.
        if (answeredRef.current === mounted.id) return;
        const loads = loadsRef.current;
        if (loads.id === mounted.id && loads.loads > 1) return;
        answeredRef.current = mounted.id;
        // Answering only while this frame is the one mounted to answer, the
        // view still may, and the card still shows this board's project and
        // path: checked at each call, so a port never outlives the
        // capability or the identity, even before its frame is replaced.
        const live = () =>
          deliverRef.current != null &&
          mountRef.current?.id === mounted.id &&
          mountRef.current.canAnswer &&
          identityRef.current.project_id === current.project_id &&
          identityRef.current.path === current.path;
        const name = boardPostedName(current.path);
        if (
          mounted.canAnswer &&
          deliverRef.current &&
          typeof data.nonce === "string" &&
          data.nonce === mounted.nonce
        ) {
          // The answers channel: one port, for this document only.
          const posted = {
            text: current.text,
            name,
            revision: current.revision,
          };
          const channel = new MessageChannel();
          closeChannel();
          const decider =
            decideEnabledRef.current && current.project_id
              ? boardDecider({
                  project_id: current.project_id,
                  path: current.path,
                  revision: current.revision,
                  text: current.text,
                })
              : undefined;
          const revoked = () =>
            new BoardAnswersRefusal(
              "Not sent: answers can't be sent from this view.",
            );
          channelRef.current = openAnswersChannel({
            port: channel.port1,
            posted,
            deliver: async (submission, opts) => {
              const deliver = deliverRef.current;
              if (!live() || !deliver) throw revoked();
              return await deliver(submission, opts);
            },
            isCurrentRevision: (r) => r === revisionRef.current,
            decide: decider
              ? async (message) => {
                  if (!live()) throw revoked();
                  return await decider(message);
                }
              : undefined,
          });
          frame.postMessage(
            { sagebrush: "board", version: 1, ...posted },
            "*",
            [channel.port2],
          );
        } else {
          // No nonce (or no answers here): the board, without Submit.
          frame.postMessage(
            { sagebrush: "board", version: 1, text: current.text, name },
            "*",
          );
        }
      } else if (
        data.sagebrush === "error" &&
        answeredRef.current === mounted.id
      ) {
        setFrameError(
          `${data.message ?? "The board could not be shown."}`.slice(0, 500),
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // Registered once: it reads the card's state only through refs.
  }, []);

  useEffect(() => closeChannel, [mount?.id]);

  const onFrameLoad = (id: number) => {
    const loads = loadsRef.current;
    if (loads.id !== id) loadsRef.current = { id, loads: 1 };
    else if (++loads.loads > 1) closeChannel();
  };

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
      {board && mount && (
        <iframe
          key={mount.id}
          ref={frameRef}
          src={
            mount.canAnswer ? `${frameUrl}#sb-nonce=${mount.nonce}` : frameUrl
          }
          onLoad={() => onFrameLoad(mount.id)}
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
