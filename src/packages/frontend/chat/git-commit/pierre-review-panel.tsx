/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Button, Checkbox } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { CodeView } from "@pierre/diffs/react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type {
  CodeViewItem,
  CodeViewLineSelection,
  CodeViewOptions,
} from "@pierre/diffs";
import { useAppearance } from "@cocalc/frontend/appearance/use-appearance";
import {
  diffFontStyle,
  diffLineHeight,
} from "@cocalc/frontend/components/diff-viewer/font-metrics";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-button";
import { DiffHighlightingProvider } from "@cocalc/frontend/components/diff-viewer/highlighting-provider";
import {
  useDiffViewPreferences,
  setDiffViewPreference,
} from "@cocalc/frontend/components/diff-viewer/view-preferences";
import { parseReviewPatchFiles } from "@cocalc/frontend/components/diff-viewer/pierre-model";
import {
  ReviewFileHeader,
  reviewFileHeaderHeight,
} from "@cocalc/frontend/components/diff-viewer/review-file-header";
import { InlineReviewCards } from "./inline-review-cards";
import { commentAnchorKey } from "./diff-lines";
import {
  buildLegacyFileLocations,
  buildLegacyReviewAnnotations,
  legacyAnchorForLocation,
  legacyFindLocation,
  legacySourceRange,
} from "./legacy-locations";
import type { ReviewDiffPanelProps } from "./review-diff-panel";
import {
  highlightPierreSearch,
  pierreSearchLines,
  PIERRE_SEARCH_CSS,
} from "./pierre-search";
import {
  capturePierreScrollAnchor,
  readScrollAnchor,
  writeScrollAnchor,
} from "@cocalc/frontend/components/diff-viewer/scroll-anchor";
import type { DiffScrollAnchor } from "@cocalc/frontend/components/diff-viewer/review-model";

export default function PierreReviewPanel(props: ReviewDiffPanelProps) {
  return (
    <DiffHighlightingProvider>
      <ReviewContent {...props} />
    </DiffHighlightingProvider>
  );
}

function ReviewContent(props: ReviewDiffPanelProps) {
  const {
    files,
    reviewEditorScope,
    navigationRef,
    activeDraft,
    activeEditingId,
  } = props;
  const { resolved } = useAppearance();
  const viewer = useRef<CodeViewHandle<string, undefined>>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const savedAnchor = useMemo(
    () =>
      props.initialScrollAnchor?.location.targetId === props.scrollScope
        ? props.initialScrollAnchor
        : props.scrollScope &&
            (!props.isHeadSelected || props.workingScrollGeneration)
          ? readScrollAnchor(props.scrollScope)
          : undefined,
    [
      props.scrollScope,
      props.initialScrollAnchor,
      props.isHeadSelected,
      props.workingScrollGeneration,
    ],
  );
  const restoredScope = useRef<string | undefined>(undefined);
  const pendingAnchor = useRef<DiffScrollAnchor | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current);
      if (pendingAnchor.current) writeScrollAnchor(pendingAnchor.current);
      pendingAnchor.current = undefined;
      restoredScope.current = undefined;
    },
    [props.scrollScope],
  );
  const { split, wrap } = useDiffViewPreferences();
  const [message, setMessage] = useState("");
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(
    null,
  );
  const locations = useMemo(() => buildLegacyFileLocations(files), [files]);
  const searchLines = useMemo(
    () => pierreSearchLines(locations, props.diffFindMatchedLineIndexes),
    [locations, props.diffFindMatchedLineIndexes],
  );
  // Pierre forces a DOM render when option identities change. In particular,
  // fresh callbacks/metrics on incidental React renders destroy native selection.
  const options = useMemo<CodeViewOptions<string, undefined>>(
    () => ({
      unsafeCSS: PIERRE_SEARCH_CSS,
      onPostRender: (node, _instance, phase, context) => {
        highlightPierreSearch(
          node,
          phase === "unmount" ? undefined : searchLines.get(context.item.id),
        );
      },
      diffStyle: split ? "split" : "unified",
      lineDiffType: "word",
      enableLineSelection: true,
      stickyHeaders: true,
      itemMetrics: {
        diffHeaderHeight: reviewFileHeaderHeight(props.fontSize),
        lineHeight: diffLineHeight(props.fontSize),
      },
      theme: { light: "github-light", dark: "github-dark" },
      themeType: resolved,
      overflow: wrap ? "wrap" : "scroll",
    }),
    [searchLines, split, wrap, resolved, props.fontSize],
  );
  useEffect(() => {
    for (const host of viewport.current?.querySelectorAll<HTMLElement>(
      "diffs-container",
    ) ?? []) {
      const id = host.querySelector<HTMLElement>("[data-review-file-id]")
        ?.dataset.reviewFileId;
      highlightPierreSearch(host, id ? searchLines.get(id) : undefined);
    }
  }, [searchLines]);
  const comments = useMemo(
    () => Array.from(props.inlineCommentsByFile.values()).flat(),
    [props.inlineCommentsByFile],
  );
  const annotations = useMemo(
    () =>
      buildLegacyReviewAnnotations({
        targetId: reviewEditorScope,
        files: locations,
        comments,
        firstParentProvenance: props.firstParentProvenance ?? true,
        showResolvedComments: props.showResolvedComments,
      }),
    [
      reviewEditorScope,
      locations,
      comments,
      props.showResolvedComments,
      props.firstParentProvenance,
    ],
  );
  const parsed = useMemo(() => {
    try {
      return {
        files: parseReviewPatchFiles(files, props.linesTruncated),
        error: "",
      };
    } catch (error) {
      return { files: [], error: String(error) };
    }
  }, [files, props.linesTruncated]);
  const itemVersion = useRef(0);
  useEffect(() => {
    const scope = props.scrollScope;
    if (!scope || !parsed.files.length || restoredScope.current === scope)
      return;
    restoredScope.current = scope;
    if (!savedAnchor || props.activeDiffFindMatch) return;
    const { fileId, side, line } = savedAnchor.location;
    const file = locations.find((file) => file.fileId === fileId);
    if (!file) return;
    if (!legacyAnchorForLocation(file, side, line)) return;
    viewer.current?.scrollTo({
      type: "line",
      id: fileId,
      lineNumber: line,
      side: side === "old" ? "deletions" : "additions",
      align: "start",
      offset: savedAnchor.offset,
      behavior: "instant",
    });
  }, [
    props.scrollScope,
    props.activeDiffFindMatch,
    parsed.files,
    locations,
    savedAnchor,
  ]);
  const items = useMemo<CodeViewItem<string>[]>(() => {
    const version = ++itemVersion.current;
    return parsed.files.map((fileDiff, index) => {
      const id = locations[index].fileId;
      const groups = annotations.byFile.get(id) ?? [];
      return {
        id,
        type: "diff",
        fileDiff,
        annotations: groups.map((group, index) => ({
          side: group.side,
          lineNumber: group.lineNumber,
          metadata: String(index),
        })),
        version,
      };
    });
  }, [parsed.files, locations, annotations]);
  useEffect(() => {
    navigationRef.current = {
      handlesSearch: true,
      navigateToFile(index) {
        const file = locations[index];
        if (file)
          viewer.current?.scrollTo({
            type: "item",
            id: file.fileId,
            align: "start",
            behavior: "instant",
          });
      },
      viewport: () => viewport.current,
    };
    return () => {
      navigationRef.current = null;
    };
  }, [locations, navigationRef]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    node.tabIndex = 0;
    node.setAttribute("role", "region");
    node.setAttribute("aria-label", "Git diff");
  }, [parsed.error]);
  useEffect(() => {
    if (!props.activeDiffFindMatch) return;
    const match = legacyFindLocation(
      reviewEditorScope,
      locations,
      props.activeDiffFindMatch,
    );
    if (!match) return;
    if (!match.location) {
      viewer.current?.scrollTo({
        type: "item",
        id: match.fileId,
        align: "start",
        behavior: "instant",
      });
      return;
    }
    const { line, side } = match.location;
    const selectionSide = side === "old" ? "deletions" : "additions";
    setSelection({
      id: match.fileId,
      range: { start: line, end: line, side: selectionSide },
    });
    viewer.current?.scrollTo({
      type: "line",
      id: match.fileId,
      lineNumber: line,
      side: selectionSide,
      align: "center",
      behavior: "instant",
    });
  }, [props.activeDiffFindMatch, locations, reviewEditorScope]);
  const selectedFile = locations.find((file) => file.fileId === selection?.id);
  const selectedAnchor =
    selectedFile && selection
      ? legacyAnchorForLocation(
          selectedFile,
          selection.range.side === "deletions" ? "old" : "new",
          selection.range.start,
        )
      : undefined;
  const editingComment = comments.find(
    (comment) => comment.id === activeEditingId,
  );
  const copy = async (text: string) => {
    try {
      await copyTextToClipboard({ text });
      setMessage("Copied");
    } catch {
      setMessage("Unable to copy. Select the text and copy manually.");
    }
  };
  const cardProps = {
    ...props,
    editorHistoryScope: reviewEditorScope,
    showDraft: false,
    activeEditingId: undefined,
    onOpenEdit: (comment: (typeof comments)[number]) => {
      if (activeDraft || activeEditingId) {
        setMessage("Save or cancel the active comment before editing another.");
      } else {
        props.onOpenEdit(comment);
      }
    },
  };
  if (parsed.error)
    return (
      <Alert
        type="warning"
        title="Pierre cannot render this patch"
        description={`${parsed.error} Try a smaller comparison or inspect the original patch with Git.`}
      />
    );
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          margin: "8px 0",
        }}
      >
        <Checkbox
          checked={split}
          onChange={(event) =>
            setDiffViewPreference("split", event.target.checked)
          }
        >
          Side by side
        </Checkbox>
        <Checkbox
          checked={wrap}
          onChange={(event) =>
            setDiffViewPreference("wrap", event.target.checked)
          }
        >
          Wrap long lines
        </Checkbox>
        <Button
          size="small"
          disabled={
            !selectedAnchor ||
            props.isHeadSelected ||
            props.commentingDisabled ||
            Boolean(activeDraft || activeEditingId)
          }
          onClick={() => {
            if (selectedAnchor) props.onOpenDraft(selectedAnchor);
          }}
        >
          Add inline comment
        </Button>
        <Button
          size="small"
          disabled={!selectedFile || !selection}
          onClick={() => {
            if (!selectedFile || !selection) return;
            if (
              selection.range.endSide &&
              selection.range.endSide !== selection.range.side
            ) {
              setMessage("Select a range on one source side to copy.");
              return;
            }
            const text = legacySourceRange(selectedFile, {
              targetId: reviewEditorScope,
              fileId: selectedFile.fileId,
              side: selection.range.side === "deletions" ? "old" : "new",
              line: Math.min(selection.range.start, selection.range.end),
              endLine: Math.max(selection.range.start, selection.range.end),
            });
            if (text == null)
              setMessage("The selected range contains unloaded context.");
            else void copy(text);
          }}
        >
          Copy selected source
        </Button>
        <Button
          size="small"
          disabled={!files.length}
          onClick={() =>
            void copy(
              files.map((file) => file.lines.join("\n") + "\n").join(""),
            )
          }
        >
          Copy loaded patch
        </Button>
      </div>
      <div role="status">{message}</div>
      <CodeView<string>
        ref={viewer}
        containerRef={viewport}
        items={items}
        selectedLines={selection}
        onSelectedLinesChange={setSelection}
        options={options}
        style={{
          height: "calc(100dvh - 100px)",
          minHeight: 200,
          overflow: "auto",
          width: "100%",
          minWidth: 0,
          ...diffFontStyle(props.fontSize),
          border: `1px solid ${UI_COLORS.border}`,
        }}
        onScroll={() => {
          const node = viewport.current;
          if (!node) return;
          if (
            props.scrollScope &&
            (!props.isHeadSelected || props.workingScrollGeneration) &&
            restoredScope.current === props.scrollScope
          ) {
            const anchor = capturePierreScrollAnchor(
              node,
              props.scrollScope,
              reviewFileHeaderHeight(props.fontSize),
            );
            if (anchor) {
              pendingAnchor.current = anchor;
              clearTimeout(saveTimer.current);
              saveTimer.current = setTimeout(
                () => writeScrollAnchor(anchor),
                150,
              );
            }
          }
          const top = node.getBoundingClientRect().top;
          const header = Array.from(
            node.querySelectorAll<HTMLElement>("[data-review-file-id]"),
          ).find((element) => element.getBoundingClientRect().bottom > top);
          const index = locations.findIndex(
            (file) => file.fileId === header?.dataset.reviewFileId,
          );
          if (index >= 0) props.onActiveFile(index);
        }}
        renderCustomHeader={(item) => {
          if (item.type !== "diff") return null;
          const file = locations.find((file) => file.fileId === item.id);
          if (!file) return null;
          const path = file.file.path;
          return (
            <div data-review-file-id={item.id}>
              <ReviewFileHeader
                path={path}
                oldPath={item.fileDiff.prevName}
                fontSize={props.fontSize}
                copyLabel={
                  props.repoRoot
                    ? "Copy absolute path"
                    : "Copy repository-relative path"
                }
                onCopyPath={() =>
                  void copy(
                    props.repoRoot
                      ? `${props.repoRoot.replace(/\/$/, "")}/${path}`
                      : path,
                  )
                }
                onCopyRelative={() => void copy(path)}
                onCopyReference={() =>
                  void copy(`${reviewEditorScope}\n${path}`)
                }
                onViewRevision={
                  props.onViewFile ? () => props.onViewFile?.(path) : undefined
                }
                onViewBefore={
                  file.file.oldSource && file.file.newSource && props.onViewFile
                    ? () => props.onViewFile?.(path, "old")
                    : undefined
                }
                onEditWorking={
                  props.isHeadSelected || props.canOpenWorkingCopy
                    ? () => void props.onOpenFile(path)
                    : undefined
                }
                workingOnly={props.isHeadSelected}
              />
            </div>
          );
        }}
        renderAnnotation={(annotation, item) => {
          const file = locations.find((file) => file.fileId === item.id);
          const group = annotations.byFile.get(item.id)?.[
            Number(annotation.metadata)
          ];
          if (!file || !group) return null;
          return (
            <InlineReviewCards
              {...cardProps}
              filePath={file.file.path}
              anchorId=""
              lineComments={group.comments}
            />
          );
        }}
      />
      {/* Active Slate editors are outside recyclable rows. Layout/scrolling cannot
        unmount an upload or lose its selection and undo session. */}
      {(activeDraft || editingComment) && (
        <section
          aria-label="Active inline comment"
          style={{
            position: "sticky",
            bottom: 0,
            background: UI_COLORS.surface,
            color: UI_COLORS.text,
            maxHeight: "40vh",
            overflow: "auto",
            borderTop: `1px solid ${UI_COLORS.border}`,
          }}
        >
          <div style={{ padding: 8, overflowWrap: "anywhere" }}>
            {activeDraft?.filePath ?? editingComment?.file_path} (
            {activeDraft?.side ?? editingComment?.side} line{" "}
            {activeDraft?.line ?? editingComment?.line})
          </div>
          <InlineReviewCards
            {...cardProps}
            filePath={activeDraft?.filePath ?? editingComment!.file_path}
            anchor={activeDraft}
            anchorId={activeDraft ? commentAnchorKey(activeDraft) : ""}
            showDraft={Boolean(activeDraft)}
            lineComments={editingComment ? [editingComment] : []}
            activeEditingId={activeEditingId}
          />
        </section>
      )}
      {annotations.unmatched.length > 0 && (
        <section aria-label="Unmatched legacy comments">
          <Alert
            type="warning"
            title="Some saved comments cannot be placed on this patch"
            description="Their original locations are preserved below; no comment has been moved or discarded."
          />
          {annotations.unmatched.map(({ comment, reason }) => (
            <div key={comment.id}>
              <p>
                {comment.file_path}: {reason}
              </p>
              <InlineReviewCards
                {...cardProps}
                filePath={comment.file_path}
                anchorId=""
                lineComments={[comment]}
              />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
