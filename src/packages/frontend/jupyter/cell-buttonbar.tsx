/*
 *  This file is part of CoCalc: Copyright © 2024 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
React component that describes the input of a cell
*/

import { Button, Dropdown } from "antd";
import { delay } from "awaiting";
import { Map } from "immutable";
import React, { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { Icon, Tooltip, isIconName } from "@cocalc/frontend/components";
import useNotebookFrameActions from "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook";
import { jupyter, labels } from "@cocalc/frontend/i18n";

import { AITools } from "@cocalc/jupyter/types";
import { CellType } from "@cocalc/util/jupyter/types";
import { JupyterActions } from "./browser-actions";
import { CodeBarDropdownMenu } from "./cell-buttonbar-menu";
import { CellIndexNumber } from "./cell-index-number";
import CellTiming from "./cell-output-time";
import {
  CODE_BAR_BTN_STYLE,
  MINI_BUTTONS_STYLE_INNER,
  RUN_ALL_CELLS_ABOVE_ICON,
  RUN_ALL_CELLS_BELOW_ICON,
} from "./consts";
import { AgentCellTool } from "./ai/agent-cell-tool";

export function PlaceholderButtonBar() {
  return <div style={CODE_BAR_BTN_STYLE} />;
}

interface Props {
  id: string;
  cell_type: CellType;
  actions?: JupyterActions;
  cell: Map<string, any>;
  is_current: boolean;
  aiTools?: AITools;
  haveAICellTools: boolean; // decides if we show the AI cell tools, depends on student project in a course, etc.
  index: number;
  is_readonly: boolean;
  input_is_readonly?: boolean;
  showControls?: boolean;
}

function areEqual(prev: Props, next: Props): boolean {
  return !(
    next.id !== prev.id ||
    next.cell_type !== prev.cell_type ||
    next.index !== prev.index ||
    next.cell !== prev.cell ||
    next.is_current !== prev.is_current ||
    (next.aiTools != null) !== (prev.aiTools != null) ||
    next.is_current !== prev.is_current ||
    next.is_readonly !== prev.is_readonly ||
    next.haveAICellTools !== prev.haveAICellTools ||
    next.showControls !== prev.showControls
  );
}

export const CellButtonBar: React.FC<Props> = React.memo(
  ({
    id,
    cell_type,
    actions,
    cell,
    aiTools,
    index,
    is_readonly,
    input_is_readonly,
    haveAICellTools,
    showControls = true,
  }: Props) => {
    const intl = useIntl();

    const frameActions = useNotebookFrameActions();
    const [formatting, setFormatting] = useState<boolean>(false);
    // The button bar is normally only shown while the cell is hovered
    // (showControls).  The dropdown popups render in a portal outside the
    // cell's DOM, so when a menu opens upward (near the bottom of the
    // viewport), moving the pointer into it leaves the cell and would unmount
    // the menu's own trigger, instantly closing the menu.  Pin the controls
    // visible while any of the dropdown menus is open.
    const [runMenuOpen, setRunMenuOpen] = useState<boolean>(false);
    const [actionMenuOpen, setActionMenuOpen] = useState<boolean>(false);
    const controlsVisible = showControls || runMenuOpen || actionMenuOpen;

    const isCodeCell = cell_type === "code";
    const isMarkdownCell = cell_type === "markdown";

    function getRunStopButton(): {
      tooltip: string;
      icon: string;
      label: string;
      onClick: () => void;
    } {
      switch (cell.get("state")) {
        case "busy":
        case "run":
        case "start":
          return {
            tooltip: "Stop this cell",
            icon: "stop",
            label: "Stop",
            onClick: () => actions?.signal("SIGINT"),
          };

        default:
          return {
            tooltip: "Run this cell",
            label: "Run",
            icon: "step-forward",
            onClick: () => frameActions.current?.run_cell(id),
          };
      }
    }

    function renderCodeBarRunStop() {
      if (
        !(isCodeCell || isMarkdownCell) ||
        id == null ||
        actions == null ||
        actions.is_closed() ||
        is_readonly
      ) {
        return;
      }

      const { label, icon, tooltip, onClick } = getRunStopButton();

      // ATTN: this must be wrapped in a plain div, otherwise it's own flex & width 100% style disturbs the button bar
      return (
        <div
          style={{
            alignItems: "center",
            color: CODE_BAR_BTN_STYLE.color,
            display: "flex",
          }}
        >
          <Dropdown.Button
            size="small"
            type="text"
            trigger={["click"]}
            mouseLeaveDelay={1.5}
            onOpenChange={setRunMenuOpen}
            icon={
              <Icon
                name="angle-down"
                style={{
                  lineHeight: 1,
                  transform: "translateY(-1px)",
                }}
              />
            }
            onClick={onClick}
            menu={{
              items: [
                {
                  key: "all-above",
                  icon: <Icon name={RUN_ALL_CELLS_ABOVE_ICON} />,
                  label: intl.formatMessage(
                    jupyter.commands.run_all_cells_above_menu,
                  ),
                  onClick: () => actions?.run_all_above_cell(id),
                },
                {
                  key: "all-below",
                  icon: <Icon name={RUN_ALL_CELLS_BELOW_ICON} rotate={"90"} />,
                  label: intl.formatMessage(
                    jupyter.commands.run_all_cells_below_menu,
                  ),
                  onClick: () => actions?.run_all_below_cell(id),
                },
              ],
            }}
          >
            <Tooltip placement="top" title={tooltip}>
              <span style={{ ...CODE_BAR_BTN_STYLE, height: "auto" }}>
                {isIconName(icon) && <Icon name={icon} />} {label}
              </span>
            </Tooltip>
          </Dropdown.Button>
        </div>
      );
    }

    function renderCodeBarCellTiming() {
      if (!isCodeCell) return;
      return (
        <div style={{ margin: "2.5px 4px 4px 0" }}>
          <CellTiming
            start={cell.get("start")}
            end={cell.get("end")}
            last={cell.get("last")}
            state={cell.get("state")}
            isLive={!is_readonly && actions != null}
            kernel={cell.get("kernel")}
          />
        </div>
      );
    }

    function renderCodeBarAIButtons() {
      if (!aiTools || !haveAICellTools || is_readonly) return;
      return (
        <AgentCellTool
          id={id}
          actions={actions}
          aiTools={aiTools}
          cellType={isCodeCell ? "code" : "markdown"}
        />
      );
    }

    function renderCodeBarFormatButton() {
      // Should only show formatter button if there is a way to format this code.
      if (!isCodeCell || is_readonly || actions == null || input_is_readonly) {
        return;
      }
      return (
        <Tooltip
          title={intl.formatMessage({
            id: "jupyter.cell-buttonbar.format-button.tooltip",
            defaultMessage: "Format this code to look nice",
            description: "Code cell in a Jupyter Notebook",
          })}
          placement="top"
        >
          <Button
            disabled={formatting}
            type="text"
            size="small"
            style={CODE_BAR_BTN_STYLE}
            onClick={async () => {
              // kind of a hack: clicking on this button makes this cell
              // the selected one
              try {
                setFormatting(true);
                await delay(1);
                await frameActions.current?.format_selected_cells();
              } finally {
                setFormatting(false);
              }
            }}
          >
            <Icon name={formatting ? "spinner" : "sitemap"} spin={formatting} />{" "}
            <FormattedMessage
              id="jupyter.cell-buttonbar.format-button.label"
              defaultMessage={"Format"}
              description={"Code cell in a Jupyter Notebook"}
            />
          </Button>
        </Tooltip>
      );
    }

    function renderDropdownMenu() {
      if (is_readonly || input_is_readonly) return;

      return (
        <CodeBarDropdownMenu
          actions={actions}
          frameActions={frameActions}
          id={id}
          cell={cell}
          onOpenChange={setActionMenuOpen}
        />
      );
    }

    function renderMarkdownEditButton() {
      if (
        !isMarkdownCell ||
        is_readonly ||
        actions == null ||
        input_is_readonly
      ) {
        return;
      }

      const editing = frameActions.current?.cell_md_is_editing(id);

      return (
        <Button
          style={CODE_BAR_BTN_STYLE}
          size="small"
          type="text"
          onClick={() => {
            frameActions.current?.toggle_md_cell_edit(id);
          }}
        >
          <Icon name={editing ? "save" : "edit"} />{" "}
          {editing
            ? intl.formatMessage(labels.save)
            : intl.formatMessage(labels.edit)}
        </Button>
      );
    }

    return (
      <div className="hidden-xs" style={MINI_BUTTONS_STYLE_INNER}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "3px",
          }}
        >
          {controlsVisible ? renderCodeBarRunStop() : null}
          {controlsVisible ? renderCodeBarAIButtons() : null}
          {controlsVisible ? renderMarkdownEditButton() : null}
          {controlsVisible ? renderCodeBarFormatButton() : null}
          {controlsVisible ? renderDropdownMenu() : null}
          {renderCodeBarCellTiming()}
          <CellIndexNumber index={index} />
        </div>
      </div>
    );
  },
  areEqual,
);
