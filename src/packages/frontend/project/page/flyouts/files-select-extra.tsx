/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space } from "antd";
import immutable from "immutable";

import { Icon, Tooltip } from "@cocalc/frontend/components";

interface FilesSelectButtonsProps {
  checked_files: immutable.Set<string>;
  mode: "open" | "select";
  selectAllFiles(): void;
  clearAllSelections(skip: boolean): void;
  setMode: (mode: "open" | "select") => void;
}

export function FilesSelectButtons({
  checked_files,
  setMode,
  mode,
  selectAllFiles,
  clearAllSelections,
}: FilesSelectButtonsProps) {
  function renderButtons() {
    if (checked_files.size > 0) {
      return (
        <Tooltip title="Deselect all selected files">
          <Button
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              clearAllSelections(false);
            }}
          >
            Clear
          </Button>
        </Tooltip>
      );
    }

    if (mode === "select") {
      return (
        <Tooltip title="Select all files">
          <Button
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              selectAllFiles();
            }}
          >
            All
          </Button>
        </Tooltip>
      );
    }

    return null;
  }

  return (
    <Space.Compact size="small">
      <Tooltip
        title={
          <>
            Switch into file selection mode.
            <br />
            Note: Like on a desktop, you can also use the Shift and Ctrl key for
            selecting files – or hover over the file icon to reveal the
            checkbox.
          </>
        }
      >
        <Button
          size="small"
          type={mode === "select" ? "primary" : "default"}
          icon={<Icon name={mode === "select" ? "check-square" : "square"} />}
          onClick={(e) => {
            e.stopPropagation();
            const nextMode = mode === "select" ? "open" : "select";
            if (nextMode === "open") {
              clearAllSelections(true);
            }
            setMode(nextMode);
          }}
        >
          Select
        </Button>
      </Tooltip>
      {renderButtons()}
    </Space.Compact>
  );
}
