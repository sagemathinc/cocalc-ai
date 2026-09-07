/*
 *  This file is part of CoCalc: Copyright © 2020-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Dropdown, Space } from "antd";
import type { Map } from "immutable";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIntl } from "react-intl";

import { useAnimatedTransition } from "@cocalc/frontend/app/animations";

import { Icon, isIconName, Tooltip } from "@cocalc/frontend/components";
import { jupyter } from "@cocalc/frontend/i18n";
import useNotebookFrameActions from "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook";
import { clear_selection } from "@cocalc/frontend/misc/clear-selection";
import MostlyStaticMarkdown from "@cocalc/frontend/editors/slate/mostly-static-markdown";
import type { AITools } from "@cocalc/jupyter/types";
import type { JupyterActions } from "@cocalc/frontend/jupyter/browser-actions";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { hash_string } from "@cocalc/util/misc";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { CellOutput } from "@cocalc/frontend/jupyter/cell-output";
import { CellToolbar } from "@cocalc/frontend/jupyter/cell-toolbar";
import { CellInput } from "@cocalc/frontend/jupyter/cell-input";
import { CellHiddenPart } from "@cocalc/frontend/jupyter/cell-hidden-part";
import { attachmentTransform } from "@cocalc/frontend/jupyter/attachment-transform";

import { AgentCellTool } from "@cocalc/frontend/jupyter/ai";
import { CodeBarDropdownMenu } from "@cocalc/frontend/jupyter/cell-buttonbar-menu";
import {
  CellChatButton,
  CellChatCompactButton,
} from "@cocalc/frontend/jupyter/cell-chat-button";
import { StudioCodePreview } from "./studio-code-preview";
import {
  CODE_BAR_BTN_STYLE,
  RUN_ALL_CELLS_ABOVE_ICON,
  RUN_ALL_CELLS_BELOW_ICON,
  SPLIT_CELL_ICON,
} from "@cocalc/frontend/jupyter/consts";
import {
  StudioGutter,
  type CellRunState,
  formatDuration,
  formatTimeAgo,
} from "./studio-gutter";
import type { StudioLayout } from "./types";
import {
  CELL_ROW_STYLE,
  CODE_FLEX_DEFAULT,
  CODE_FLEX_EDITING,
  COLUMN_TRANSITION,
  OUTPUT_FLEX_DEFAULT,
  OUTPUT_FLEX_EDITING,
} from "./styles";

interface StudioCellProps {
  id: string;
  index: number;
  cell: Map<string, any>;
  // interactive stdin request from the kernel (input()); same contract as the
  // regular cell: only set when this cell is asking for input.
  stdin?;
  // optimistic pending-run output overlay
  runOverlay?: Map<string, any>;
  isDragging?: boolean;
  cm_options: Map<string, any>;
  actions?: JupyterActions;
  name?: string;
  font_size: number;
  project_id?: string;
  directory?: string;
  mode: "edit" | "escape";
  is_current?: boolean;
  is_selected?: boolean;
  is_markdown_edit?: boolean;
  is_focused?: boolean;
  is_visible?: boolean;
  more_output?: Map<string, any>;
  trust?: boolean;
  complete?: Map<string, any>;
  aiTools?: AITools;
  read_only?: boolean;
  cell_toolbar?: string;
  positionInBlock: number;
  blockSize: number;
  headingLevel: number;
  blockCellIds?: string[];
  isFirst?: boolean;
  isLast?: boolean;
  isLastBlock?: boolean;
  sectionCollapsed?: boolean;
  // aggregate execution state of the folded section (block-start cell only)
  collapsedRunState?: "running" | "error" | null;
  onToggleSection?: () => void;
  sectionTitle?: string;
  blockHighlighted?: boolean;
  onHoverBlock?: (hover: boolean) => void;
  studioLayout?: StudioLayout;
  readingMode?: boolean;
  frameHeight?: number;
}

export const StudioCell: React.FC<StudioCellProps> = React.memo((props) => {
  const {
    id,
    index,
    cell,
    stdin,
    runOverlay,
    isDragging,
    cm_options,
    actions,
    name,
    font_size,
    project_id,
    directory,
    is_current,
    is_markdown_edit,
    is_focused,
    more_output,
    trust,
    complete,
    aiTools,
    read_only,
    cell_toolbar,
    positionInBlock,
    blockSize,
    blockCellIds,
    isFirst,
    isLast,
    isLastBlock,
    sectionCollapsed,
    collapsedRunState,
    onToggleSection,
    sectionTitle,
    studioLayout = "comfortable",
    readingMode = false,
    frameHeight,
  } = props;

  const intl = useIntl();
  const columnTransition = useAnimatedTransition(COLUMN_TRANSITION);
  const frameActions = useNotebookFrameActions();
  const fileContext = useFileContext();
  const [mdHovered, setMdHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  // Protected (metadata.editable=false) cell whose editor is open read-only
  // for inspection; the notebook itself stays in escape mode for these.
  const [viewProtected, setViewProtected] = useState(false);
  useEffect(() => {
    if (!is_current && viewProtected) {
      setViewProtected(false);
    }
  }, [is_current, viewProtected]);
  const [rowHovered, setRowHovered] = useState(false);
  const controlsVisible = rowHovered || menuOpen || chatMenuOpen;
  const outputRef = useRef<HTMLDivElement>(null);
  const [outputHeight, setOutputHeight] = useState<number>(0);

  // FileContext that suppresses CellButtonBar and other extras in studio mode
  const studioFileContext = { ...fileContext, disableExtraButtons: true };

  // Same URL transform as the regular CellInput markdown path, so that
  // "attachment:name.png" images embedded in the notebook render in studio
  // mode too.
  const cellAttachments = cell.get("attachments");
  const urlTransform = useCallback(
    (url: string, tag?: string) => {
      const url1 = attachmentTransform(cell, url);
      if (url1 != null && url1 != url) {
        return url1;
      }
      return fileContext.urlTransform?.(url, tag);
    },
    [cellAttachments, fileContext.urlTransform],
  );

  const cellType = cell.get("cell_type") || "code";
  const isCode = cellType === "code";
  const isMarkdown = cellType === "markdown";
  const isRaw = cellType === "raw";
  const input = cell.get("input") || "";
  // Mount CellOutput not only for persisted output, but also while the kernel
  // is asking for stdin (input()) or an optimistic run overlay is pending;
  // otherwise those transient states would be invisible in studio mode.
  const hasTransientOrPersistedOutput =
    cell.get("output") != null || stdin != null || runOverlay != null;
  const sourceHidden = !!cell.getIn(["metadata", "jupyter", "source_hidden"]);
  const isNotEditable = !cell.getIn(["metadata", "editable"], true);
  const isNotDeletable = !cell.getIn(["metadata", "deletable"], true);

  // Track whether cell input changed since last execution
  const lastExecHashRef = useRef<{
    execCount: number | undefined;
    hash: number;
  } | null>(null);
  const execCount = cell.get("exec_count");
  if (
    isCode &&
    execCount != null &&
    execCount !== lastExecHashRef.current?.execCount
  ) {
    lastExecHashRef.current = { execCount, hash: hash_string(input) };
  }

  // Determine cell execution state for gutter coloring
  const cellRunState: CellRunState = (() => {
    if (!isCode) return "markdown";
    const state = cell.get("state");
    if (state === "busy") return "running";
    if (state === "run" || state === "start") return "queued";
    // Check for error in output
    const output = cell.get("output");
    if (output) {
      for (const [, msg] of output) {
        if (msg?.get?.("traceback")) return "error";
      }
    }
    // Only "stale" for cells never executed in this session
    if (!cell.get("exec_count") && !output && lastExecHashRef.current == null)
      return "stale";
    return "idle";
  })();

  const isDirty =
    isCode &&
    cellRunState === "idle" &&
    lastExecHashRef.current != null &&
    lastExecHashRef.current.hash !== hash_string(input);

  const handleRun = useCallback(() => {
    frameActions.current?.run_cell(id);
  }, [id]);

  const handleStop = useCallback(() => {
    actions?.signal("SIGINT");
  }, [actions]);

  const isBusy = cellRunState === "running" || cellRunState === "queued";

  const handleRunSectionAbove = useCallback(() => {
    if (!actions || !blockCellIds) return;
    const idx = blockCellIds.indexOf(id);
    if (idx <= 0) return;
    const cells_map = actions.store.get("cells");
    for (let i = 0; i < idx; i++) {
      const c = cells_map?.get(blockCellIds[i]);
      if (c && (c.get("cell_type") || "code") === "code") {
        frameActions.current?.run_cell(blockCellIds[i]);
      }
    }
  }, [actions, blockCellIds, id]);

  const handleRunSectionBelow = useCallback(() => {
    if (!actions || !blockCellIds) return;
    const idx = blockCellIds.indexOf(id);
    if (idx === -1) return;
    const cells_map = actions.store.get("cells");
    for (let i = idx; i < blockCellIds.length; i++) {
      const c = cells_map?.get(blockCellIds[i]);
      if (c && (c.get("cell_type") || "code") === "code") {
        frameActions.current?.run_cell(blockCellIds[i]);
      }
    }
  }, [actions, blockCellIds, id]);

  function renderRunDropdownButton(extraStyle?: React.CSSProperties) {
    const icon = isBusy ? "stop" : "step-forward";
    const label = isBusy ? "Stop" : "Run";
    const tooltip = isBusy ? "Interrupt execution" : runTooltip;
    const onClick = isBusy ? handleStop : handleRun;
    // height "auto": CODE_BAR_BTN_STYLE's fixed 24px would top-align the
    // label inside the 24px button and misalign it with the caret button
    // (same treatment as the split button in cell-buttonbar.tsx).
    const btnStyle = isBusy
      ? {
          ...CODE_BAR_BTN_STYLE,
          height: "auto",
          color: UI_COLORS.danger,
          ...extraStyle,
        }
      : { ...CODE_BAR_BTN_STYLE, height: "auto", ...extraStyle };

    const sectionIdx = blockCellIds?.indexOf(id) ?? -1;
    const hasSection = blockCellIds != null && blockCellIds.length > 1;

    const items: any[] = [];
    if (hasSection) {
      items.push(
        {
          key: "section-above",
          icon: <Icon name={RUN_ALL_CELLS_ABOVE_ICON} />,
          label: "Run above in section",
          disabled: sectionIdx <= 0,
          onClick: handleRunSectionAbove,
        },
        {
          key: "section-below",
          icon: <Icon name={RUN_ALL_CELLS_BELOW_ICON} rotate={"90"} />,
          label: "Run cell and below in section",
          onClick: handleRunSectionBelow,
        },
        { type: "divider" },
      );
    }
    items.push(
      {
        key: "all-above",
        icon: <Icon name={RUN_ALL_CELLS_ABOVE_ICON} />,
        label: intl.formatMessage(jupyter.commands.run_all_cells_above_menu),
        onClick: () => actions?.run_all_above_cell(id),
      },
      {
        key: "all-below",
        icon: <Icon name={RUN_ALL_CELLS_BELOW_ICON} rotate={"90"} />,
        label: intl.formatMessage(jupyter.commands.run_all_cells_below_menu),
        onClick: () => actions?.run_all_below_cell(id),
      },
    );

    return (
      <div style={{ display: "flex", alignItems: "center" }}>
        <Space.Compact size="small">
          <Button size="small" type="text" onClick={onClick}>
            <Tooltip placement="top" title={tooltip}>
              <span style={btnStyle}>
                {isIconName(icon) && <Icon name={icon} />} {label}
              </span>
            </Tooltip>
          </Button>
          <Dropdown trigger={["click"]} mouseLeaveDelay={1.5} menu={{ items }}>
            <Button
              size="small"
              type="text"
              icon={
                <Icon
                  name="angle-down"
                  style={{
                    lineHeight: 1,
                    transform: "translateY(-1px)",
                  }}
                />
              }
            />
          </Dropdown>
        </Space.Compact>
      </div>
    );
  }

  const handleActivateCode = useCallback(() => {
    if (read_only) return;
    if (isNotEditable) {
      // Protected cell: activate_cell downgrades "edit" to "escape", so the
      // notebook never enters edit mode.  Still open this cell's editor
      // read-only so the code can be inspected and copied.
      setViewProtected(true);
    }
    frameActions.current?.activate_cell(id, {
      mode: "edit",
      clearSelection: true,
    });
  }, [id, read_only, isNotEditable]);

  const handleCloseEditor = useCallback(() => {
    setViewProtected(false);
    frameActions.current?.activate_cell(id, {
      mode: "escape",
      clearSelection: true,
    });
  }, [id]);

  // Click on cell to select (same as default notebook)
  const handleClickCell = useCallback(
    (event: React.MouseEvent) => {
      if (event.shiftKey && !is_current) {
        clear_selection();
        frameActions.current?.select_cell_range(id);
        return;
      }
      frameActions.current?.activate_cell(id, {
        mode: "escape",
        clearSelection: true,
      });
    },
    [id, is_current],
  );

  const handleRunAndClose = useCallback(() => {
    setViewProtected(false);
    frameActions.current?.run_cell(id);
    frameActions.current?.activate_cell(id, {
      mode: "escape",
      clearSelection: true,
    });
  }, [id]);

  const handleToggleMdEdit = useCallback(() => {
    // protected markdown (metadata.editable=false) is rendered read-only;
    // its content is already fully visible, so there is nothing to open
    if (read_only || isNotEditable) return;
    if (is_markdown_edit) {
      frameActions.current?.set_md_cell_not_editing(id);
    } else {
      frameActions.current?.switch_md_cell_to_edit(id);
    }
  }, [id, is_markdown_edit, read_only]);

  const handleRunSection = useCallback(() => {
    if (!actions || !blockCellIds) return;
    const cells_map = actions.store.get("cells");
    for (const cellId of blockCellIds) {
      const c = cells_map?.get(cellId);
      if (c && (c.get("cell_type") || "code") === "code") {
        frameActions.current?.run_cell(cellId);
      }
    }
  }, [actions, blockCellIds]);

  const cellStart = cell.get("start");
  const cellEnd = cell.get("end");
  const runTooltip = useMemo((): React.ReactNode => {
    if (cellStart != null && cellEnd != null && cellEnd > cellStart) {
      const duration = formatDuration(cellEnd - cellStart);
      const ago = formatTimeAgo(new Date(cellEnd));
      return (
        <span>
          Took {duration}, {ago}
        </span>
      );
    }
    return "Run this cell";
  }, [cellStart, cellEnd]);

  // Measure output *content* height (not the flex-stretched container)
  const outputContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = outputContentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setOutputHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const viewportHalf = frameHeight ? Math.round(frameHeight * 0.5) : 400;
  // View mode: match output height (the code fades out if taller)
  const codePreviewMaxHeight = outputHeight || undefined;
  // Edit mode: max of output height and 50% viewport
  const codeEditMaxHeight = Math.max(outputHeight, viewportHalf);

  // Show section divider for the first cell in every block
  const isBlockStart = positionInBlock === 0;
  const showSectionDivider = isBlockStart;

  // Non-first cells in a collapsed section: render nothing
  if (sectionCollapsed && !isBlockStart) {
    return null;
  }

  // Cell is being edited when it's the current cell in edit mode.  This is
  // possible in reading mode too (via double-click on the output or the pencil
  // button): the cell temporarily reveals its code column just for editing.
  const isActiveEditing =
    is_current && (props.mode === "edit" || viewProtected) && isCode;

  const outputFlex = isActiveEditing
    ? OUTPUT_FLEX_EDITING
    : OUTPUT_FLEX_DEFAULT;
  const codeFlex = isActiveEditing ? CODE_FLEX_EDITING : CODE_FLEX_DEFAULT;
  const showCode = !readingMode || isActiveEditing;
  // In reading mode at wide width, don't render the empty code column — output goes full
  // width — except while this cell is being edited.
  const showCodeColumn = showCode || studioLayout !== "wide";

  // Layout spacers: to center the output, left spacer must offset the code column
  const margin = studioLayout === "narrow" ? 2 : 0;
  const leftSpacerFlex =
    studioLayout === "wide" ? 0 : margin + CODE_FLEX_DEFAULT;
  const rightSpacerFlex = studioLayout === "wide" ? 0 : margin;
  const hasSpacer = leftSpacerFlex > 0;
  const contentFlex = OUTPUT_FLEX_DEFAULT + CODE_FLEX_DEFAULT;
  const wrapCentered = (content: React.ReactNode) => {
    if (!hasSpacer) return content;
    return (
      <div style={{ display: "flex" }}>
        <div
          style={{
            flex: `${leftSpacerFlex} 1 0`,
            transition: columnTransition,
          }}
        />
        <div
          style={{
            flex: `${contentFlex} 1 0`,
            minWidth: 0,
            transition: columnTransition,
          }}
        >
          {content}
        </div>
        {rightSpacerFlex > 0 && (
          <div
            style={{
              flex: `${rightSpacerFlex} 1 0`,
              transition: columnTransition,
            }}
          />
        )}
      </div>
    );
  };

  const cmOpts = cm_options.get("options")?.toJS() ?? {};

  // Mirror the regular CellInput markdown path: run notebook-specific
  // preprocessing (e.g. \label/\ref handling) before rendering.
  function renderMarkdownValue(): string {
    let value = input.trim();
    if (actions?.processRenderedMarkdown != null) {
      value = actions.processRenderedMarkdown({ value, id }) ?? value;
    }
    return value;
  }

  // Section divider bar — appears at the start of every section
  // In reading mode, add an empty spacer matching the code column so the bar
  // doesn't stretch into the empty code area.
  const sectionRunButton =
    !read_only && blockCellIds ? handleRunSection : undefined;
  const sectionDivider = showSectionDivider ? (
    <SectionDividerRow
      isFirst={isFirst}
      sectionCollapsed={sectionCollapsed}
      runState={sectionCollapsed ? collapsedRunState : undefined}
      sectionTitle={sectionTitle}
      onToggle={onToggleSection}
      onRunSection={sectionRunButton}
      showCode={!readingMode}
      codeFlex={CODE_FLEX_DEFAULT}
      outputFlex={OUTPUT_FLEX_DEFAULT}
      readingMode={readingMode}
      studioLayout={studioLayout}
    />
  ) : null;

  // When collapsed, only show the divider bar
  // If this is the last section, add a [+] that unfolds and inserts
  if (sectionCollapsed && isBlockStart) {
    return wrapCentered(
      <>
        {sectionDivider}
        {isLastBlock && !read_only && actions && blockCellIds?.length && (
          <div style={{ padding: "8px 0 0 4px" }}>
            <Tooltip title="Add cell at end of this section" placement="right">
              <Button
                type="text"
                size="small"
                icon={<Icon name="plus" />}
                onClick={() => {
                  // Unfold the section first
                  onToggleSection?.();
                  // Insert after last cell in block
                  const lastId = blockCellIds[blockCellIds.length - 1];
                  const newId = actions.insert_cell_adjacent(lastId, 1);
                  // Focus and scroll to the new cell
                  if (newId) {
                    frameActions.current?.set_cur_id(newId);
                    frameActions.current?.scroll("cell visible");
                  }
                }}
                style={{ color: UI_COLORS.secondary }}
              />
            </Tooltip>
          </div>
        )}
      </>,
    );
  }

  return wrapCentered(
    <>
      {sectionDivider}
      <div
        style={CELL_ROW_STYLE}
        id={id}
        onMouseUp={is_current ? undefined : handleClickCell}
        onMouseEnter={() => setRowHovered(true)}
        onMouseLeave={() => setRowHovered(false)}
      >
        <StudioGutter
          id={id}
          index={index}
          isCode={isCode}
          positionInBlock={positionInBlock}
          blockSize={blockSize}
          showBlockLine={true}
          cellRunState={cellRunState}
          onRun={isCode ? handleRun : undefined}
          onStop={isCode ? handleStop : undefined}
          onInsertCell={
            actions ? () => actions.insert_cell_adjacent(id, 1) : undefined
          }
          read_only={read_only}
          onToggleSection={onToggleSection}
          blockHighlighted={props.blockHighlighted}
          onHoverBlock={props.onHoverBlock}
          isCurrent={is_current}
          isSelected={props.is_selected}
          start={cell.get("start")}
          end={cell.get("end")}
          isDirty={isDirty}
          isNotEditable={isNotEditable}
          isNotDeletable={isNotDeletable}
        />

        {/* Content area — toolbar + output/code columns */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {cell_toolbar && actions && (
            <div className="studio-cell-toolbar">
              <CellToolbar
                actions={actions}
                cell_toolbar={cell_toolbar}
                cell={cell}
              />
            </div>
          )}
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "stretch",
              flex: 1,
            }}
          >
            {/* Output column */}
            <div
              ref={outputRef}
              style={{
                flex: `${outputFlex} 1 0`,
                minWidth: 0,
                overflow: "hidden",
                transition: columnTransition,
                padding: "4px 8px",
                position: "relative",
              }}
              onDoubleClick={
                // Reading mode hides the code column; double-clicking the output
                // opens the code editor for just this cell (same gesture as
                // markdown cells).
                readingMode && isCode && !read_only && !isActiveEditing
                  ? handleActivateCode
                  : undefined
              }
            >
              <div ref={outputContentRef}>
                {/* Reading mode: floating toolbar inside output area (hidden
                    while editing — the editor brings its own buttons) */}
                {readingMode && !isActiveEditing && (
                  <div
                    style={{
                      position: "absolute",
                      top: "2px",
                      right: "4px",
                      zIndex: 5,
                      display: "flex",
                      gap: "2px",
                      alignItems: "center",
                      background: controlsVisible
                        ? "rgba(255,255,255,0.85)"
                        : "transparent",
                      borderRadius: "4px",
                      padding: controlsVisible ? "1px" : 0,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {controlsVisible ? (
                      <>
                        {isCode && !read_only && (
                          <Tooltip title="Edit this code cell" placement="top">
                            <Button
                              type="text"
                              size="small"
                              icon={<Icon name="pencil" />}
                              onClick={handleActivateCode}
                            />
                          </Tooltip>
                        )}
                        {isCode && !read_only && renderRunDropdownButton()}
                        {isCode && !read_only && aiTools && actions && (
                          <AgentCellTool
                            id={id}
                            actions={actions}
                            aiTools={aiTools}
                            cellType="code"
                          />
                        )}
                        {actions && (
                          <CellChatButton
                            cellId={id}
                            onOpenChange={setChatMenuOpen}
                          />
                        )}
                        <CodeBarDropdownMenu
                          actions={actions}
                          frameActions={frameActions}
                          id={id}
                          cell={cell}
                          onOpenChange={setMenuOpen}
                          hideSplitCell
                        />
                      </>
                    ) : (
                      <CellChatCompactButton cellId={id} />
                    )}
                  </div>
                )}
                {isCode && hasTransientOrPersistedOutput && (
                  <ScrollToBottomOutput frameHeight={frameHeight}>
                    <CellOutput
                      cell={cell}
                      actions={actions}
                      name={name}
                      id={id}
                      project_id={project_id}
                      directory={directory}
                      more_output={more_output}
                      trust={trust}
                      hidePrompt
                      aiTools={aiTools}
                      isDragging={isDragging}
                      stdin={stdin}
                      runOverlay={runOverlay}
                      readOnly={read_only}
                    />
                  </ScrollToBottomOutput>
                )}
                {isCode &&
                  !hasTransientOrPersistedOutput &&
                  !input.trim() &&
                  !read_only &&
                  !readingMode && (
                    // The whole empty area is a click target that opens the
                    // code editor -- aiming for the tiny links is bad UX.
                    // Only the "text" link diverges (converts to markdown).
                    <div
                      style={{
                        color: UI_COLORS.muted,
                        padding: "8px 4px",
                        fontSize: "13px",
                        minHeight: "36px",
                        cursor: "text",
                      }}
                      onClick={handleActivateCode}
                    >
                      {"Write "}
                      <a
                        onClick={(e) => {
                          e.stopPropagation();
                          handleActivateCode();
                        }}
                        style={{ color: UI_COLORS.muted }}
                      >
                        code
                      </a>
                      {", "}
                      <a
                        style={{ color: UI_COLORS.muted }}
                        onClick={(e) => {
                          e.stopPropagation();
                          frameActions.current?.set_selected_cell_type(
                            "markdown",
                          );
                          // Small delay so cell type change propagates before opening editor
                          setTimeout(() => {
                            frameActions.current?.switch_md_cell_to_edit(id);
                          }, 0);
                        }}
                      >
                        text
                      </a>
                    </div>
                  )}
                {isMarkdown && !is_markdown_edit && (
                  <div
                    style={{ position: "relative", minHeight: "24px" }}
                    onMouseEnter={() => setMdHovered(true)}
                    onMouseLeave={() => setMdHovered(false)}
                    onDoubleClick={handleToggleMdEdit}
                  >
                    {input.trim() ? (
                      <FileContext.Provider
                        value={{ ...fileContext, urlTransform }}
                      >
                        <div className="cocalc-jupyter-rendered cocalc-jupyter-rendered-md studio-md-render">
                          <MostlyStaticMarkdown
                            value={renderMarkdownValue()}
                            onChange={
                              read_only || isNotEditable
                                ? undefined
                                : (value) =>
                                    actions?.set_cell_input(id, value, true)
                            }
                          />
                        </div>
                      </FileContext.Provider>
                    ) : (
                      <div
                        style={{
                          color: UI_COLORS.muted,
                          padding: "4px",
                          fontStyle: "italic",
                          cursor: "pointer",
                        }}
                        onClick={handleToggleMdEdit}
                      >
                        empty markdown
                      </div>
                    )}
                    {(mdHovered || !input.trim()) &&
                      !read_only &&
                      !isNotEditable && (
                        <Tooltip
                          title="Edit this markdown cell"
                          placement="top"
                        >
                          <Button
                            type="text"
                            size="small"
                            icon={<Icon name="pencil" />}
                            onClick={handleToggleMdEdit}
                            style={{
                              position: "absolute",
                              top: "2px",
                              right: "2px",
                              opacity: 0.7,
                            }}
                          />
                        </Tooltip>
                      )}
                  </div>
                )}
                {isMarkdown && is_markdown_edit && (
                  <div
                    style={{ position: "relative" }}
                    className="studio-code-editor"
                  >
                    <FileContext.Provider value={studioFileContext}>
                      <CellInput
                        cell={cell}
                        actions={actions}
                        cm_options={cm_options}
                        is_markdown_edit={true}
                        is_focused={!!is_focused}
                        is_current={!!is_current}
                        id={id}
                        index={index}
                        font_size={font_size}
                        project_id={project_id}
                        directory={directory}
                        trust={trust}
                        is_readonly={!!read_only}
                        input_is_readonly={
                          !cell.getIn(["metadata", "editable"], true)
                        }
                      />
                    </FileContext.Provider>
                    <Tooltip title="Done editing" placement="top">
                      <Button
                        type="text"
                        size="small"
                        icon={<Icon name="check" />}
                        onClick={handleToggleMdEdit}
                        style={{
                          position: "absolute",
                          top: "2px",
                          right: "2px",
                        }}
                      />
                    </Tooltip>
                  </div>
                )}
                {/* Raw cells render verbatim as a plain <pre> block. No
                    execution, no syntax highlighting. Edit via the 3-dot menu
                    (switch cell type to code or markdown). */}
                {isRaw &&
                  (input.trim() ? (
                    <pre
                      style={{
                        margin: 0,
                        padding: "4px 8px",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: "monospace",
                        fontSize: `${font_size}px`,
                        color: UI_COLORS.text,
                        background: "transparent",
                        border: "none",
                      }}
                    >
                      {input}
                    </pre>
                  ) : (
                    <div
                      style={{
                        color: UI_COLORS.muted,
                        padding: "4px 8px",
                        fontStyle: "italic",
                      }}
                    >
                      empty raw cell
                    </div>
                  ))}
              </div>
              {/* end outputContentRef */}
            </div>

            {/* Code column — hidden entirely in reading mode at wide width */}
            {showCodeColumn && (
              <div
                style={{
                  flex: `${codeFlex} 1 0`,
                  minWidth: 0,
                  overflow: "visible",
                  transition: columnTransition,
                  position: "relative",
                  zIndex: 1,
                  borderLeft: readingMode ? "none" : "1px solid #eee",
                }}
              >
                {showCode && (
                  <>
                    {/* Cell action toolbar — hover only, above code */}
                    {isCode && !isActiveEditing && (
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "flex-end",
                          padding: "0 4px",
                          minHeight: "22px",
                          gap: "2px",
                          alignItems: "center",
                          position: "relative",
                          zIndex: 2,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {controlsVisible ? (
                          <>
                            {!read_only &&
                              renderRunDropdownButton({
                                marginRight: "auto",
                              })}
                            {!read_only && aiTools && actions && (
                              <AgentCellTool
                                id={id}
                                actions={actions}
                                aiTools={aiTools}
                                cellType={isCode ? "code" : "markdown"}
                              />
                            )}
                            {actions && (
                              <CellChatButton
                                cellId={id}
                                onOpenChange={setChatMenuOpen}
                              />
                            )}
                            <CodeBarDropdownMenu
                              actions={actions}
                              frameActions={frameActions}
                              id={id}
                              cell={cell}
                              onOpenChange={setMenuOpen}
                              hideSplitCell
                            />
                          </>
                        ) : (
                          <CellChatCompactButton cellId={id} />
                        )}
                      </div>
                    )}
                    {isCode && !isActiveEditing && !sourceHidden && (
                      <StudioCodePreview
                        value={input}
                        cmOptions={cmOpts}
                        fontSize={font_size}
                        onActivate={handleActivateCode}
                        highlighted={rowHovered}
                        maxHeight={codePreviewMaxHeight}
                        blocked={isNotEditable}
                      />
                    )}
                    {isCode && !isActiveEditing && sourceHidden && (
                      <CellHiddenPart
                        onReveal={
                          actions != null && !read_only
                            ? () =>
                                actions.set_jupyter_metadata(
                                  id,
                                  "source_hidden",
                                  undefined,
                                )
                            : undefined
                        }
                        revealLabel="Show hidden cell input"
                        title={
                          actions == null || read_only
                            ? "Input is hidden."
                            : "Input is hidden. Click to show it."
                        }
                      />
                    )}
                    {isCode && isActiveEditing && (
                      <div
                        onBlur={(e) => {
                          // Close editor when focus leaves the entire editing area
                          // (but not when clicking buttons inside it)
                          if (
                            !e.currentTarget.contains(e.relatedTarget as Node)
                          ) {
                            handleCloseEditor();
                          }
                        }}
                      >
                        {/* toolbar sits as a tab on the top edge of the
                            editor box, so it never covers the first line
                            of code in narrow views */}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "flex-end",
                            paddingRight: "10px",
                          }}
                        >
                          <div
                            style={{
                              position: "relative",
                              zIndex: 1,
                              display: "flex",
                              gap: "2px",
                              background: UI_COLORS.surface,
                              border: `1px solid ${UI_COLORS.muted}`,
                              borderBottom: "none",
                              borderRadius: "4px 4px 0 0",
                              padding: "1px 2px",
                              // overlap the editor's top border so the tab
                              // visually belongs to the box below
                              marginBottom: "-1px",
                            }}
                          >
                            {/* labeled Run first, so the small icon-only
                              buttons next to it aren't clicked by accident */}
                            <Tooltip
                              title="Run cell and close editor"
                              placement="top"
                            >
                              <Button
                                type="text"
                                size="small"
                                icon={<Icon name="play" />}
                                onClick={handleRunAndClose}
                              >
                                Run
                              </Button>
                            </Tooltip>
                            {/* splitting would modify a protected cell, so
                              hide it in the read-only view */}
                            {!isNotEditable && (
                              <Tooltip
                                title="Split cell at cursor"
                                placement="top"
                              >
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<Icon name={SPLIT_CELL_ICON} />}
                                  onClick={() => {
                                    // needs the live editor for the cursor
                                    // position, so it only exists here and not
                                    // in the (closed-editor) dropdown menu
                                    frameActions.current?.split_current_cell();
                                  }}
                                />
                              </Tooltip>
                            )}
                            <Tooltip title="Close editor" placement="top">
                              <Button
                                type="text"
                                size="small"
                                icon={<Icon name="times" />}
                                onClick={handleCloseEditor}
                              />
                            </Tooltip>
                          </div>
                        </div>
                        <div
                          style={{
                            maxHeight: `${codeEditMaxHeight}px`,
                            overflowY: "auto",
                            overflowX: "hidden",
                          }}
                        >
                          <FileContext.Provider value={studioFileContext}>
                            <div
                              className="studio-code-editor"
                              style={{ position: "relative" }}
                            >
                              <CellInput
                                cell={cell}
                                actions={actions}
                                cm_options={cm_options}
                                is_markdown_edit={false}
                                is_focused={!!is_focused}
                                is_current={!!is_current}
                                id={id}
                                index={index}
                                font_size={font_size}
                                project_id={project_id}
                                directory={directory}
                                complete={complete}
                                trust={trust}
                                is_readonly={!!read_only}
                                input_is_readonly={
                                  !cell.getIn(["metadata", "editable"], true)
                                }
                                aiTools={aiTools}
                              />
                            </div>
                          </FileContext.Provider>
                        </div>
                      </div>
                    )}
                    {/* Non-code (markdown, raw) cell toolbar in code column — 3-dot menu for cell actions */}
                    {(isMarkdown || isRaw) && (
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "flex-end",
                          padding: "0 4px",
                          minHeight: "22px",
                          alignItems: "center",
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {controlsVisible ? (
                          <>
                            {actions && (
                              <CellChatButton
                                cellId={id}
                                onOpenChange={setChatMenuOpen}
                              />
                            )}
                            <CodeBarDropdownMenu
                              actions={actions}
                              frameActions={frameActions}
                              id={id}
                              cell={cell}
                              onOpenChange={setMenuOpen}
                              hideSplitCell
                            />
                          </>
                        ) : (
                          <CellChatCompactButton cellId={id} />
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          {/* end output+code row */}
        </div>
        {/* end content area */}
      </div>
      {isLast && !read_only && actions && (
        <div style={{ padding: "8px 0 0 4px" }}>
          <Tooltip title="Add cell at end" placement="right">
            <Button
              type="text"
              size="small"
              icon={<Icon name="plus" />}
              onClick={() => {
                const newId = actions.insert_cell_adjacent(id, 1);
                if (newId) {
                  frameActions.current?.set_cur_id(newId);
                  frameActions.current?.scroll("cell visible");
                }
              }}
              style={{ color: UI_COLORS.secondary }}
            />
          </Tooltip>
        </div>
      )}
    </>,
  );
});

/** Wrapper that caps output height and auto-scrolls to bottom on changes */
function ScrollToBottomOutput({
  children,
  frameHeight,
}: {
  children: React.ReactNode;
  frameHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scrollToBottom = () => {
      el.scrollTop = el.scrollHeight;
    };
    // Defer initial scroll until after browser layout is complete
    const raf = requestAnimationFrame(scrollToBottom);
    // Re-scroll on any child DOM mutation (new output lines)
    const observer = new MutationObserver(() => {
      requestAnimationFrame(scrollToBottom);
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      style={{
        maxHeight: frameHeight ? `${Math.round(frameHeight * 0.7)}px` : "70vh",
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/** Section divider row — single hover state across output and code columns */
function SectionDividerRow({
  isFirst,
  sectionCollapsed,
  runState,
  sectionTitle,
  onToggle,
  onRunSection,
  showCode,
  codeFlex,
  outputFlex,
  readingMode,
  studioLayout,
}: {
  isFirst?: boolean;
  sectionCollapsed?: boolean;
  // execution feedback for a folded section: pulse green while running,
  // tint red when a hidden cell errored
  runState?: "running" | "error" | null;
  sectionTitle?: string;
  onToggle?: () => void;
  onRunSection?: () => void;
  showCode?: boolean;
  codeFlex: number;
  outputFlex: number;
  readingMode?: boolean;
  studioLayout?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const bg =
    runState === "error"
      ? UI_COLORS.dangerBg
      : hovered
        ? UI_COLORS.hover
        : UI_COLORS.inset;
  const borderTop = isFirst ? undefined : `1px solid ${UI_COLORS.border}`;
  const borderBottom = `1px solid ${UI_COLORS.border}`;
  const segmentClass =
    runState === "running" ? "studio-section-running" : undefined;
  const segmentStyle: React.CSSProperties = {
    backgroundColor: bg,
    borderTop,
    borderBottom,
    transition: "background-color 150ms ease",
  };

  return (
    <div
      style={{ display: "flex", cursor: "pointer" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onToggle}
    >
      {/* Output column side */}
      <div
        className={segmentClass}
        style={{
          flex: `${outputFlex} 1 0`,
          display: "flex",
          alignItems: "center",
          minHeight: "24px",
          ...segmentStyle,
        }}
      >
        {/* Gutter-width area with toggle icon */}
        <div
          style={{
            width: "44px",
            minWidth: "44px",
            display: "flex",
            justifyContent: "flex-start",
            alignItems: "center",
            paddingLeft: "2px",
          }}
        >
          <Icon
            name={sectionCollapsed ? "plus-square" : "minus-square"}
            style={{ color: UI_COLORS.secondary, fontSize: "14px" }}
          />
        </div>
        {/* Title */}
        {sectionCollapsed && sectionTitle ? (
          <span
            style={{
              color: UI_COLORS.text,
              fontSize: "13px",
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              padding: "0 8px",
            }}
          >
            {sectionTitle}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        {/* Run button in reading mode (no code column) */}
        {onRunSection && !showCode && (
          <Tooltip title="Run all code cells in this section">
            <Button
              type="text"
              size="small"
              icon={<Icon name="play" />}
              onClick={(e) => {
                e.stopPropagation();
                onRunSection();
              }}
              style={{
                color: UI_COLORS.secondary,
                visibility: hovered ? "visible" : "hidden",
                marginRight: "4px",
              }}
            >
              Run
            </Button>
          </Tooltip>
        )}
      </div>
      {/* Code column side */}
      {showCode && (
        <div
          className={segmentClass}
          style={{
            flex: `${codeFlex} 1 0`,
            display: "flex",
            alignItems: "center",
            padding: "0 4px",
            ...segmentStyle,
          }}
        >
          {onRunSection && (
            <Tooltip title="Run all code cells in this section">
              <Button
                type="text"
                size="small"
                icon={<Icon name="play" />}
                onClick={(e) => {
                  e.stopPropagation();
                  onRunSection();
                }}
                style={{
                  ...CODE_BAR_BTN_STYLE,
                  marginLeft: "auto",
                  visibility: hovered ? "visible" : "hidden",
                }}
              >
                Run
              </Button>
            </Tooltip>
          )}
        </div>
      )}
      {/* Empty spacer for reading mode below wide width — no background so bar ends at output column */}
      {readingMode && studioLayout !== "wide" && (
        <div style={{ flex: `${codeFlex} 1 0` }} />
      )}
    </div>
  );
}
