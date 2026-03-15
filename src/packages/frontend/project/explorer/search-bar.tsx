/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { Alert, Flex } from "antd";
import { useIntl } from "react-intl";
import { Icon, SearchInput } from "@cocalc/frontend/components";
import { ProjectActions } from "@cocalc/frontend/project_store";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useProjectContext } from "../context";
import { TerminalModeDisplay } from "@cocalc/frontend/project/explorer/file-listing/terminal-mode-display";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";
import { SearchHistoryDropdown } from "./search-history-dropdown";
import { useExplorerSearchHistory } from "./use-search-history";
import { isTerminalMode } from "@cocalc/frontend/project/explorer/file-listing/utils";

const HelpStyle = {
  wordWrap: "break-word",
  top: "40px",
  position: "absolute",
  width: "100%",
  height: "38",
  boxShadow: "#999 6px 6px 6px",
  zIndex: 100,
  borderRadius: "15px",
} as const;

type FindPrefill = {
  tab: "contents" | "files" | "snapshots" | "backups";
  query: string;
  submode?: "files" | "contents";
};

function parseFindPrefill(input: string): FindPrefill | null {
  const trimmed = input.trimStart();
  if (!trimmed) return null;
  if (trimmed.startsWith("?")) {
    return { tab: "contents", query: trimmed.slice(1).trim() };
  }
  const lower = trimmed.toLowerCase();
  if (lite) {
    if (lower.startsWith("backup:") || lower.startsWith("backups:")) {
      return null;
    }
    if (lower.startsWith("snapshot:") || lower.startsWith("snapshots:")) {
      return null;
    }
  }
  if (lower.startsWith("backup:") || lower.startsWith("backups:")) {
    const prefix = lower.startsWith("backups:") ? "backups:" : "backup:";
    return { tab: "backups", query: trimmed.slice(prefix.length).trim() };
  }
  if (lower.startsWith("snapshot:") || lower.startsWith("snapshots:")) {
    const prefix = lower.startsWith("snapshots:") ? "snapshots:" : "snapshot:";
    return {
      tab: "snapshots",
      query: trimmed.slice(prefix.length).trim(),
      submode: "files",
    };
  }
  if (trimmed.startsWith("/ ")) {
    return { tab: "files", query: trimmed.slice(2).trim() };
  }
  return null;
}

function describeFindPrefill(prefill: FindPrefill): string {
  const query = prefill.query ? ` for \"${prefill.query}\"` : "";
  switch (prefill.tab) {
    case "contents":
      return `Press Enter to search file contents${query}.`;
    case "files":
      return `Press Enter to search file names${query}.`;
    case "snapshots":
      return `Press Enter to search snapshots${query}.`;
    case "backups":
      return `Press Enter to search backups${query}.`;
    default:
      return "Press Enter to search.";
  }
}

export const outputMinitermStyle: CSSProperties = {
  background: "white",
  position: "absolute",
  zIndex: 10,
  boxShadow: "-4px 4px 7px #aaa",
  maxHeight: "450px",
  overflow: "auto",
  right: 0,
  marginTop: "36px",
  marginRight: "5px",
  borderRadius: "5px",
  width: "100%",
} as const;

interface Props {
  file_search: string;
  current_path: string;
  actions: ProjectActions;
  create_file: (a, b) => void;
  create_folder: (a) => void;
  onTerminalCommand?: () => void;
  file_creation_error?: string;
  disabled?: boolean;
  ext_selection?: string;
}

// Commands such as CD throw a setState error.
// Search WARNING to find the line in this class.
export const SearchBar = memo(
  ({
    file_search = "",
    current_path,
    actions,
    create_file,
    create_folder,
    onTerminalCommand,
    file_creation_error,
    disabled = false,
    ext_selection,
  }: Props) => {
    const intl = useIntl();
    const { project_id } = useProjectContext();
    const {
      history,
      initialized: historyInitialized,
      addHistoryEntry,
    } = useExplorerSearchHistory(project_id);
    const numDisplayedFiles =
      useTypedRedux({ project_id }, "numDisplayedFiles") ?? 0;

    // edit → run → edit
    // TODO use "state" to show a progress spinner while a command is running
    // @ts-ignore
    const [state, set_state] = useState<"edit" | "run">("edit");
    const [error, set_error] = useState<string | undefined>(undefined);
    const [stdout, set_stdout] = useState<string | undefined>(undefined);
    const [historyMode, setHistoryMode] = useState(false);
    const [historyIndex, setHistoryIndex] = useState(0);
    const inputFocusedRef = useRef(false);
    const previousSearchRef = useRef(file_search);
    const skipNextClearHistoryRef = useRef(false);

    const _id = useRef<number>(0);
    const [cmd, set_cmd] = useState<{ input: string; id: number } | undefined>(
      undefined,
    );

    useEffect(() => {
      actions.set_file_search("");
    }, [current_path]);

    useEffect(() => {
      if (!historyMode) return;
      if (history.length === 0) {
        setHistoryMode(false);
        setHistoryIndex(0);
        return;
      }
      if (historyIndex >= history.length) {
        setHistoryIndex(history.length - 1);
      }
    }, [history, historyIndex, historyMode]);

    useEffect(() => {
      const prev = previousSearchRef.current;
      if (prev === file_search) {
        return;
      }
      previousSearchRef.current = file_search;

      if (file_search.length > 0 || !prev) {
        return;
      }

      if (skipNextClearHistoryRef.current) {
        skipNextClearHistoryRef.current = false;
        return;
      }

      if (!inputFocusedRef.current) {
        addHistoryEntry(prev);
      }
    }, [addHistoryEntry, file_search]);

    useEffect(() => {
      if (cmd == null) return;
      const { input, id } = cmd;
      const input0 = input + '\necho $HOME "`pwd`"';
      webapp_client.exec({
        project_id,
        command: input0,
        timeout: 10,
        max_output: 100000,
        bash: true,
        path: current_path,
        err_on_exit: false,
        filesystem: true,
        cb(err, output) {
          if (id !== _id.current) {
            // computation was canceled -- ignore result.
            return;
          }
          if (err) {
            set_error(JSON.stringify(err));
            set_state("edit");
          } else {
            if (output.stdout) {
              // Find the current path
              // after the command is executed, and strip
              // the output of "pwd" from the output:
              let s = output.stdout.trim();
              let i = s.lastIndexOf("\n");
              if (i === -1) {
                output.stdout = "";
              } else {
                s = s.slice(i + 1);
                output.stdout = output.stdout.slice(0, i);
              }
              i = s.indexOf(" ");
              const full_path = s.slice(i + 1);
              if (full_path.slice(0, i) === s.slice(0, i)) {
                // only change if in project
                const path = s.slice(2 * i + 2);
                actions.open_directory(path);
              }
            }
            if (!output.stderr) {
              // only log commands that worked...
              actions.log({ event: "termInSearch", input });
            }
            // WARNING: RENDER ERROR. Move state to redux store
            set_state("edit");
            set_error(output.stderr);
            set_stdout(output.stdout);
            if (!output.stderr) {
              actions.set_file_search("");
            }
          }
        },
      });
    }, [cmd]);

    // Miniterm functionality
    function execute_command(command: string): void {
      set_error("");
      set_stdout("");
      const input = command.trim();
      if (!input) {
        return;
      }
      onTerminalCommand?.();
      set_state("run");
      _id.current = _id.current + 1;
      set_cmd({ input, id: _id.current });
    }

    function render_help_info() {
      if (historyMode) {
        return;
      }
      const prefill = parseFindPrefill(file_search);
      if (prefill) {
        return (
          <Alert
            style={HelpStyle}
            type="info"
            title={describeFindPrefill(prefill)}
          />
        );
      }
      if (isTerminalMode(file_search)) {
        return (
          <TerminalModeDisplay
            style={{
              top: "35px",
              left: "-260px",
              position: "absolute",
              width: "260px",
              height: "38",
              boxShadow: "#999 6px 6px 6px",
              zIndex: 100,
              borderRadius: "5px",
              opacity: 0.8,
            }}
          />
        );
      }
      if (file_search.length > 0 && numDisplayedFiles > 0) {
        let text;
        const firstFolderPosition = file_search.indexOf("/");
        if (file_search === " /") {
          text = "Showing all folders in this directory";
        } else if (firstFolderPosition === file_search.length - 1) {
          text = `Showing folders matching ${file_search.slice(
            0,
            file_search.length - 1,
          )}`;
        } else {
          text = `Showing files matching "${file_search}"`;
        }
        return <Alert style={HelpStyle} type="info" title={text} />;
      }
    }

    function render_file_creation_error() {
      if (file_creation_error) {
        return (
          <Alert
            style={{ wordWrap: "break-word", marginBottom: "10px" }}
            type="error"
            closable
            onClose={dismiss_alert}
            title={file_creation_error}
          />
        );
      }
    }

    // Miniterm functionality
    function render_output(x: string | undefined, style: CSSProperties) {
      if (x) {
        return (
          <pre style={style}>
            <a
              onClick={(e) => {
                e.preventDefault();
                set_stdout("");
                set_error("");
              }}
              href=""
              style={{
                right: "5px",
                top: "0px",
                color: "#666",
                fontSize: "14pt",
                position: "absolute",
                background: "white",
              }}
            >
              <Icon name="times" />
            </a>
            {x}
          </pre>
        );
      }
    }

    function dismiss_alert(): void {
      actions.setState({ file_creation_error: "" });
    }

    function search_submit(
      value: string,
      { ctrl_down, shift_down }: { ctrl_down: boolean; shift_down: boolean },
    ): void {
      const prefill = parseFindPrefill(value);
      if (historyMode) {
        apply_history_selection();
        return;
      }
      if (prefill && actions) {
        addHistoryEntry(value);
        const nextState: any = {
          find_tab: prefill.tab,
          find_prefill: {
            ...prefill,
            scope_path: current_path,
          },
        };
        if (prefill.tab === "contents") {
          nextState.user_input = prefill.query;
        }
        actions.setState(nextState);
        actions.setFlyoutExpanded("search", true);
        return;
      }
      if (isTerminalMode(value)) {
        if (value.slice(1).trim().length > 0) {
          addHistoryEntry(value);
        }
        const command = value.slice(1, value.length);
        execute_command(command);
      } else if (file_search.length > 0 && shift_down) {
        addHistoryEntry(value);
        // only create a file, if shift is pressed as well to avoid creating
        // jupyter notebooks (default file-type) by accident.
        if (file_search[file_search.length - 1] === "/") {
          create_folder(!ctrl_down);
        } else {
          create_file(undefined, !ctrl_down);
        }
        actions.clear_selected_file_index();
      }
    }

    function on_up_press(): void {
      if (!historyMode && historyInitialized && history.length > 0) {
        setHistoryMode(true);
        setHistoryIndex(0);
        return;
      }
      if (historyMode) {
        setHistoryIndex((idx) => Math.max(idx - 1, 0));
      }
    }

    function on_down_press(): void {
      if (historyMode) {
        setHistoryIndex((idx) =>
          Math.min(idx + 1, Math.max(0, history.length - 1)),
        );
      }
    }

    function on_change(search: string): void {
      setHistoryMode(false);
      setHistoryIndex(0);
      actions.zero_selected_file_index();
      actions.set_file_search(search);
    }

    function on_escape(): boolean {
      if (!historyMode) {
        return false;
      }
      setHistoryMode(false);
      setHistoryIndex(0);
      return true;
    }

    function apply_history_selection(idx?: number): void {
      const value = history[idx ?? historyIndex];
      setHistoryMode(false);
      setHistoryIndex(0);
      if (value == null) {
        return;
      }
      actions.zero_selected_file_index();
      actions.set_file_search(value);
    }

    function on_focus(): void {
      inputFocusedRef.current = true;
    }

    function on_blur(): void {
      inputFocusedRef.current = false;
      setHistoryMode(false);
      setHistoryIndex(0);
    }

    function on_clear(): void {
      if (file_search) {
        addHistoryEntry(file_search);
        skipNextClearHistoryRef.current = true;
      }
      setHistoryMode(false);
      setHistoryIndex(0);
      actions.clear_selected_file_index();
      set_stdout("");
      set_error("");
    }

    function render_history_dropdown() {
      if (!historyMode || history.length === 0) {
        return;
      }
      return (
        <SearchHistoryDropdown
          history={history}
          historyIndex={historyIndex}
          setHistoryIndex={setHistoryIndex}
          onSelect={apply_history_selection}
        />
      );
    }

    return (
      <Flex style={{ flex: "1 0 auto", position: "relative" }} vertical={true}>
        <SearchInput
          autoFocus
          autoSelect
          placeholder={intl.formatMessage({
            id: "project.explorer.search-bar.placeholder",
            defaultMessage: 'Filter files or "!" or "/" for Terminal...',
          })}
          value={file_search}
          on_change={on_change}
          on_submit={search_submit}
          on_up={on_up_press}
          on_down={on_down_press}
          on_clear={on_clear}
          on_escape={on_escape}
          on_blur={on_blur}
          on_focus={on_focus}
          disabled={disabled || !!ext_selection}
          status={
            file_search.length > 0 && !isTerminalMode(file_search)
              ? "warning"
              : undefined
          }
          focus={current_path}
        />
        {render_file_creation_error()}
        {render_history_dropdown()}
        {render_help_info()}
        <div style={{ ...outputMinitermStyle, width: "100%", left: 0 }}>
          {render_output(error, {
            color: "darkred",
            margin: 0,
          })}
          {render_output(stdout, { margin: 0 })}
        </div>
      </Flex>
    );
  },
);
