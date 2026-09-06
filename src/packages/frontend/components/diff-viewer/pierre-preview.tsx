/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button } from "antd";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  CodeViewItem,
  CodeViewLineSelection,
  SelectionSide,
} from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { COLORS } from "@cocalc/util/theme";
import { MarkdownHistoryInput } from "@cocalc/frontend/chat/git-commit/review-editors";
import {
  matchGitDrawerScrollCommand,
  runGitDrawerScrollCommand,
} from "@cocalc/frontend/chat/git-commit/drawer-scroll";
import {
  getEventPath,
  isEditableOrKeyboardInteractiveTarget,
} from "@cocalc/frontend/keyboard/boundary";
import { containsPreviewLine, parsePreviewSource } from "./pierre-model";
import type { DiffPreviewSource } from "./preview-types";

type PreviewComment = {
  id: string;
  fileId: string;
  line: number;
  side: SelectionSide;
  body: string;
};

export default function PierrePreview({
  source,
  fontSize,
}: {
  source: DiffPreviewSource;
  fontSize: number;
}) {
  const scope = useId();
  const viewer = useRef<CodeViewHandle<string, undefined>>(null);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    node.tabIndex = 0;
    node.setAttribute("role", "region");
    node.setAttribute("aria-label", "Diff preview");
    node.setAttribute(
      "aria-keyshortcuts",
      "Space Shift+Space PageDown PageUp ArrowDown ArrowUp Home",
    );
    node.focus({ preventScroll: true });
  }, []);
  const [fileIndex, setFileIndex] = useState(0);
  const [line, setLine] = useState("1");
  const [side, setSide] = useState<SelectionSide>("additions");
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [message, setMessage] = useState("");
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(
    null,
  );
  const [comments, setComments] = useState<PreviewComment[]>([]);
  const parsed = useMemo(() => {
    const started = performance.now();
    try {
      return {
        files: parsePreviewSource(source),
        ms: performance.now() - started,
        error: "",
      };
    } catch (err) {
      return { files: [], ms: performance.now() - started, error: String(err) };
    }
  }, [source]);
  const items = useMemo<CodeViewItem<string>[]>(
    () =>
      parsed.files.map((fileDiff, index) => {
        const annotations = comments
          .filter((comment) => comment.fileId === String(index))
          .map((comment) => ({
            side: comment.side,
            lineNumber: comment.line,
            metadata: comment.id,
          }));
        return {
          id: String(index),
          type: "diff",
          fileDiff,
          annotations,
          // Pierre retains item payloads until their version changes. Source is
          // frozen and anchors only append; editing draft text is React-only.
          version: annotations.length,
        };
      }),
    [parsed.files, comments],
  );
  const options = useMemo(
    () => ({
      diffStyle: split ? ("split" as const) : ("unified" as const),
      lineDiffType: "word" as const,
      enableLineSelection: true,
      stickyHeaders: true,
      // A collapsed context jump only reaches its separator in Pierre 1.3.6.
      expandUnchanged: source.kind === "documents",
      theme: { light: "github-light", dark: "github-dark" },
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
    }),
    [split, wrap, source.kind],
  );

  const goToLine = () => {
    const file = parsed.files[fileIndex];
    const n = Number(line);
    if (!file || !containsPreviewLine(file, n, side)) {
      setMessage(
        "That line is not present in the supplied version or patch. This prototype does not fetch historical file contents.",
      );
      return;
    }
    setMessage("");
    viewer.current?.scrollTo({
      type: "line",
      id: String(fileIndex),
      lineNumber: n,
      side,
      align: "center",
      behavior: "instant",
    });
    setSelection({ id: String(fileIndex), range: { start: n, end: n, side } });
  };
  const addComment = () => {
    if (!selection) return;
    const selectedSide = selection.range.side ?? "additions";
    const id = `${selection.id}:${selectedSide}:${selection.range.start}`;
    setComments((previous) =>
      previous.some((comment) => comment.id === id)
        ? previous
        : [
            ...previous,
            {
              id,
              fileId: selection.id,
              side: selectedSide,
              line: selection.range.start,
              body: "",
            },
          ],
    );
    viewer.current?.scrollTo({
      type: "line",
      id: selection.id,
      lineNumber: selection.range.start,
      side: selectedSide,
      align: "center",
      behavior: "instant",
    });
  };
  if (parsed.error)
    return (
      <Alert
        type="error"
        title="Cannot preview this diff"
        description={parsed.error}
      />
    );
  return (
    <div
      onKeyDown={(event) => {
        const native = event.nativeEvent;
        if (event.defaultPrevented || native.isComposing) return;
        const path = getEventPath(native);
        const node = viewport.current;
        if (
          !node ||
          !path.includes(node) ||
          path.some(isEditableOrKeyboardInteractiveTarget)
        )
          return;
        const command = matchGitDrawerScrollCommand(native);
        if (!command) return;
        // Contain scrolling even at the first/last line, rather than scrolling
        // the modal or invoking the Git drawer underneath it.
        event.preventDefault();
        event.stopPropagation();
        runGitDrawerScrollCommand(node, command);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 0,
        width: "100%",
      }}
    >
      <Alert
        type="info"
        title="Prototype: comments are temporary"
        description="Comments stay while you scroll, but closing this preview discards them. Nothing is submitted to an agent or saved as a review."
      />
      <div style={{ overflowWrap: "anywhere" }}>{source.label}</div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            minWidth: 0,
            maxWidth: "100%",
          }}
        >
          File{" "}
          <select
            aria-label="Preview file"
            value={fileIndex}
            onChange={(event) => {
              const id = event.target.value;
              setFileIndex(Number(id));
              setSelection(null);
              setMessage("");
              viewer.current?.scrollTo({
                type: "item",
                id,
                align: "start",
                behavior: "instant",
              });
            }}
            style={{ width: "min(32rem, 65vw)", minWidth: 0, maxWidth: "100%" }}
          >
            {parsed.files.map((file, index) => (
              <option key={index} value={index}>
                {file.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Side{" "}
          <select
            aria-label="Preview side"
            value={side}
            onChange={(event) => setSide(event.target.value as SelectionSide)}
          >
            <option value="additions">New</option>
            <option value="deletions">Old</option>
          </select>
        </label>
        <label>
          Line{" "}
          <input
            aria-label="Preview line"
            type="number"
            min={1}
            value={line}
            onChange={(event) => setLine(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") goToLine();
            }}
            style={{ width: 80 }}
          />
        </label>
        <Button onClick={goToLine}>Go to line</Button>
        <label>
          <input
            type="checkbox"
            checked={split}
            onChange={(event) => setSplit(event.target.checked)}
          />{" "}
          Side by side
        </label>
        <label>
          <input
            type="checkbox"
            checked={wrap}
            onChange={(event) => setWrap(event.target.checked)}
          />{" "}
          Wrap long lines
        </label>
        <Button disabled={!selection} onClick={addComment}>
          Add temporary comment
        </Button>
      </div>
      <div role="status">
        {message ||
          `${parsed.files.length} files; parsed in ${parsed.ms.toFixed(1)} ms. Select a line number to attach a comment.`}
      </div>
      <div>
        Diff scrolling: Space / Shift+Space, Page Down / Page Up, arrow keys,
        and Home. Comments and controls keep their normal keys.
      </div>
      <CodeView<string>
        className="cocalc-pierre-preview-viewport"
        containerRef={viewport}
        ref={viewer}
        items={items}
        options={options}
        selectedLines={selection}
        onSelectedLinesChange={setSelection}
        style={{
          height: "60vh",
          minHeight: 200,
          // Pierre virtualizes against this element's own scroll viewport.
          overflow: "auto",
          minWidth: 0,
          width: "100%",
          maxWidth: "100%",
          boxSizing: "border-box",
          border: `1px solid ${COLORS.GRAY_L}`,
          fontSize,
        }}
        renderAnnotation={(annotation) => {
          const comment = comments.find(
            (entry) => entry.id === annotation.metadata,
          );
          if (!comment) return null;
          return (
            <div
              style={{ padding: 12, background: COLORS.GRAY_LLL, minWidth: 0 }}
            >
              <div>
                Temporary comment (
                {comment.side === "additions" ? "new" : "old"} line{" "}
                {comment.line})
              </div>
              <MarkdownHistoryInput
                historyId={`${scope}:${comment.id}`}
                cacheId={`${scope}:${comment.id}`}
                value={comment.body}
                onChange={(body) =>
                  setComments((previous) =>
                    previous.map((entry) =>
                      entry.id === comment.id ? { ...entry, body } : entry,
                    ),
                  )
                }
                fontSize={fontSize}
                autoGrow
                autoGrowMaxHeight={220}
                hideHelp
                minimal
                compact
                enableMentions={false}
                enableUpload={true}
                placeholder="Temporary rich-text comment..."
              />
            </div>
          );
        }}
      />
    </div>
  );
}
