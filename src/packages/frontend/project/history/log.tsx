/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Flex, Popconfirm, Radio, Space, Switch } from "antd";
import { List } from "immutable";
import { FormattedMessage, useIntl } from "react-intl";
import { VirtuosoHandle } from "react-virtuoso";

import StatefulVirtuoso from "@cocalc/frontend/components/stateful-virtuoso";
import {
  React,
  redux,
  Rendered,
  TypedMap,
  useActions,
  useEffect,
  useForceUpdate,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon, Loading, TimeAgo, Tooltip } from "@cocalc/frontend/components";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { labels } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import DiskUsage from "@cocalc/frontend/project/disk-usage/disk-usage";
import { get_local_storage, set_local_storage } from "@cocalc/frontend/misc";
import { ManagedEgressCompactButton } from "@cocalc/frontend/purchases/managed-egress-history";
import { User } from "@cocalc/frontend/users";
import { rowBackground, search_match, search_split } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import {
  FlyoutLogMode,
  getFlyoutLogDeduplicate,
  getFlyoutLogFilter,
  getFlyoutLogMode,
  isFlyoutLogMode,
  storeFlyoutState,
} from "../page/flyouts/state";
import {
  FLYOUT_LOG_FILTER_DEFAULT,
  FlyoutLogFilter,
} from "../page/flyouts/utils";
import { LogEntry } from "./log-entry";
import { LogSearch } from "./search";
import { EventRecord, to_search_string } from "./types";
import { handleFileEntryClick } from "./utils";
import type { IconName } from "@cocalc/frontend/components/icon";

interface Props {
  project_id: string;
}

const LOG_WORKSPACE_ONLY_STORAGE_PREFIX = "project-log-workspace-only";

interface OpenedFile {
  filename: string;
  time?: Date;
  account_id: string;
}

const MODE_TOGGLE_STYLE = {
  alignItems: "center",
  display: "inline-flex",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: "22px",
} as const;

const MODE_TOGGLE_BUTTON_STYLE = {
  lineHeight: "22px",
} as const;

const LOG_FILTER_ACTIVE_BUTTON_STYLE = {
  backgroundColor: COLORS.BLUE_LLLL,
  borderColor: COLORS.BLUE_LLL,
  color: COLORS.BLUE_DD,
} as const;

const PROJECT_EVENTS = [
  "project_start_requested",
  "project_stop_requested",
  "project_restart_requested",
  "project_move_requested",
  "project_moved",
  "project_move_failed",
  "project_move_canceled",
  "project_rehomed",
  "project_stopped",
  "project_started",
  "start_project",
  "upgrade",
  "delete_project",
  "hide_project",
  "unhide_project",
] as const;

const USER_EVENTS = [
  "invite_user",
  "invite_nonuser",
  "remove_collaborator",
] as const;

function workspaceOnlyStorageKey(project_id: string): string {
  return `${LOG_WORKSPACE_ONLY_STORAGE_PREFIX}:${project_id}`;
}

function loadWorkspaceOnly(project_id: string): boolean {
  const raw = get_local_storage(workspaceOnlyStorageKey(project_id));
  if (typeof raw !== "string") return true;
  return raw !== "false";
}

function saveWorkspaceOnly(project_id: string, enabled: boolean): void {
  set_local_storage(
    workspaceOnlyStorageKey(project_id),
    enabled ? "true" : "false",
  );
}

function getEventName(entry: TypedMap<EventRecord>): string | undefined {
  const event = entry.get("event");
  if (event == null || typeof event === "string") return;
  const name = event.get("event");
  return typeof name === "string" ? name : undefined;
}

function isProjectEvent(
  event: string | undefined,
  entry: TypedMap<EventRecord>,
): boolean {
  if (event == null) return false;
  if (PROJECT_EVENTS.includes(event as any)) {
    return true;
  }
  if (event === "set") {
    const data = entry.get("event");
    if (data == null || typeof data === "string") return false;
    const attrs = ["title", "description", "image", "name"];
    return attrs.some((attr) => typeof data.get(attr) === "string");
  }
  return false;
}

function isFileEvent(
  event: string | undefined,
  entry: TypedMap<EventRecord>,
): boolean {
  if (event !== "open") return false;
  const data = entry.get("event");
  return (
    data != null &&
    typeof data !== "string" &&
    typeof data.get("filename") === "string"
  );
}

function isUserEvent(event: string | undefined): boolean {
  return event != null && USER_EVENTS.includes(event as any);
}

export const ProjectLog: React.FC<Props> = ({ project_id }) => {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const { workspaces } = useProjectContext();
  const project_log = useTypedRedux({ project_id }, "project_log");
  const project_log_loading = useTypedRedux(
    { project_id },
    "project_log_loading",
  );
  const project_log_deleting = useTypedRedux(
    { project_id },
    "project_log_deleting",
  );
  const project_log_loading_older = useTypedRedux(
    { project_id },
    "project_log_loading_older",
  );
  const project_log_has_older = useTypedRedux(
    { project_id },
    "project_log_has_older",
  );
  const project_log_error = useTypedRedux({ project_id }, "project_log_error");
  const search = useTypedRedux({ project_id }, "search") ?? "";
  const user_map = useTypedRedux("users", "user_map");
  const [mode, setMode] = useState<FlyoutLogMode>(() =>
    getFlyoutLogMode(project_id),
  );
  const [logFilter, setLogFilter] = useState<List<FlyoutLogFilter>>(() =>
    List(getFlyoutLogFilter(project_id) ?? FLYOUT_LOG_FILTER_DEFAULT),
  );
  const showOpenFiles = logFilter.contains("open");
  const showFileActions = logFilter.contains("files");
  const showProject = logFilter.contains("project");
  const showOther = logFilter.contains("other");
  const showUser = logFilter.contains("user");
  const [deduplicate, setDeduplicate] = useState<boolean>(() =>
    getFlyoutLogDeduplicate(project_id),
  );
  const actions = useActions({ project_id });
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const state = useRef<{
    log?: List<TypedMap<EventRecord>>;
    files?: OpenedFile[];
    search_cache: { [key: string]: string };
    loading_table?: boolean;
    next_cursor_pos?: number;
  }>({ search_cache: {} });
  const [cursor_index, set_cursor_index] = useState<number>(0);
  const [workspaceOnly, setWorkspaceOnly] = useState<boolean>(() =>
    loadWorkspaceOnly(project_id),
  );
  const force_update = useForceUpdate();
  useEffect(() => {
    delete state.current.log;
    delete state.current.files;
    force_update();
  }, [
    project_log,
    search,
    workspaceOnly,
    workspaces.current,
    mode,
    deduplicate,
    logFilter,
  ]);

  useEffect(() => {
    actions?.refresh_project_log();
  }, [actions, project_id]);

  useEffect(() => {
    setMode(getFlyoutLogMode(project_id));
    setDeduplicate(getFlyoutLogDeduplicate(project_id));
    setLogFilter(
      List(getFlyoutLogFilter(project_id) ?? FLYOUT_LOG_FILTER_DEFAULT),
    );
    setWorkspaceOnly(loadWorkspaceOnly(project_id));
  }, [project_id]);

  useEffect(() => {
    saveWorkspaceOnly(project_id, workspaceOnly);
  }, [project_id, workspaceOnly]);

  function get_log(): List<TypedMap<EventRecord>> {
    if (state.current.log != null) {
      return state.current.log;
    }
    const log = project_log;
    if (log == null) {
      state.current.log = List();
      return state.current.log;
    }

    let log_seq = log.valueSeq().toList();
    if (workspaceOnly && workspaces.current) {
      const workspaceId = workspaces.current.workspace_id;
      log_seq = log_seq.filter((entry) => {
        const paths = getEntryPaths(entry);
        if (paths.length === 0) return true;
        return paths.some(
          (path) =>
            workspaces.resolveWorkspaceForPath(path)?.workspace_id ===
            workspaceId,
        );
      });
    }
    log_seq = log_seq.filter(matches_log_filter);
    if (search) {
      if (state.current.search_cache == undefined) {
        state.current.search_cache = {};
      }
      const terms = search_split(search.toLowerCase());
      const names = {};
      const match = (z: TypedMap<EventRecord>): boolean => {
        let s: string = state.current.search_cache[z.get("id")];
        if (s == undefined) {
          const account_id = z.get("account_id");
          if (names[account_id] == null) {
            names[account_id] = (
              redux.getStore("users").get_name(account_id) ?? ""
            ).toLowerCase();
          }
          s = names[account_id];
          const event = z.get("event");
          if (event != undefined) {
            s += " " + to_search_string(event.toJS());
          }
          state.current.search_cache[z.get("id")] = s;
        }
        return search_match(s, terms);
      };
      log_seq = log_seq.filter(match);
    }
    log_seq = log_seq.sort((a, b) => {
      // time might not be defined at all -- see https://github.com/sagemathinc/cocalc/issues/4271
      // In this case we don't really care what happens with this log
      // entry, only that we don't completely crash cocalc!
      const t0 = b.get("time");
      if (!t0) {
        return -1; // push to the past -- otherwise it would be annoyingly in your face all the time.
      }
      const t1 = a.get("time");
      if (!t1) {
        return 1; // push to the past
      }
      return t0.valueOf() - t1.valueOf();
    });
    state.current.log = log_seq;
    return state.current.log;
  }

  function matches_log_filter(entry: TypedMap<EventRecord>): boolean {
    const event = getEventName(entry);
    if (isFileEvent(event, entry)) {
      return showOpenFiles;
    }
    if (event === "file_action") {
      return showFileActions;
    }
    if (isProjectEvent(event, entry)) {
      return showProject;
    }
    if (isUserEvent(event)) {
      return showUser;
    }
    return showOther;
  }

  function get_opened_files(): OpenedFile[] {
    if (state.current.files != null) {
      return state.current.files;
    }
    const log = project_log;
    if (log == null) {
      state.current.files = [];
      return state.current.files;
    }

    const terms = search ? search_split(search.toLowerCase()) : null;
    const names = {};
    const files: OpenedFile[] = [];
    const seen = new Set<string>();
    const workspaceId = workspaces.current?.workspace_id;

    log
      .valueSeq()
      .sort((a, b) => {
        const t0 = b.get("time")?.valueOf() ?? 0;
        const t1 = a.get("time")?.valueOf() ?? 0;
        return t0 - t1;
      })
      .forEach((entry: TypedMap<EventRecord>) => {
        const event = entry.get("event");
        if (event == null || typeof event === "string") return;
        if (event.get("event") !== "open") return;

        const filename = event.get("filename");
        if (typeof filename !== "string" || filename.length === 0) return;
        if (deduplicate && seen.has(filename)) return;

        if (
          workspaceOnly &&
          workspaceId != null &&
          workspaces.resolveWorkspaceForPath(filename)?.workspace_id !==
            workspaceId
        ) {
          return;
        }

        const account_id = entry.get("account_id");
        if (terms != null) {
          if (names[account_id] == null) {
            names[account_id] = (
              redux.getStore("users").get_name(account_id) ?? ""
            ).toLowerCase();
          }
          if (!search_match(`${filename} ${names[account_id]}`, terms)) return;
        }

        seen.add(filename);
        files.push({
          filename,
          time: entry.get("time"),
          account_id,
        });
      });

    state.current.files = files;
    return state.current.files;
  }

  function getEntryPaths(entry: TypedMap<EventRecord>): string[] {
    const out: string[] = [];
    const push = (value: unknown) => {
      if (typeof value === "string" && value.length > 0) {
        out.push(value);
      }
    };
    const event = entry.get("event");
    if (event == null || typeof event === "string") return out;
    push(event.get("filename"));
    push(event.get("path"));
    push(event.get("src"));
    push(event.get("dest"));
    const files = event.get("files") as unknown;
    if (Array.isArray(files)) {
      for (const file of files) push(file);
    } else if (files && typeof (files as any).forEach === "function") {
      (files as any).forEach((file) => push(file));
    }
    return out;
  }

  function move_cursor_to(cursor_index): void {
    const size = mode === "files" ? get_opened_files().length : get_log().size;
    if (cursor_index < 0 || cursor_index >= size) {
      return;
    }
    set_cursor_index(cursor_index);
    virtuosoRef.current?.scrollIntoView({ index: cursor_index });
  }

  function increment_cursor(): void {
    move_cursor_to(cursor_index + 1);
  }

  function decrement_cursor(): void {
    move_cursor_to(cursor_index - 1);
  }

  function reset_cursor(): void {
    move_cursor_to(0);
  }

  function load_all(): void {
    state.current.next_cursor_pos = get_log().size - 1;
    state.current.loading_table = false;
    actions?.project_log_load_all();
  }

  function render_load_all_button(): Rendered {
    if (!project_log_has_older) {
      return <div style={{ height: "1px" }} />;
    }
    return (
      <div style={{ textAlign: "center", padding: "15px" }}>
        <Button onClick={load_all} loading={!!project_log_loading_older}>
          Show all log entries...
        </Button>
      </div>
    );
  }

  function row_renderer(index): Rendered {
    const log = get_log();
    if (index === log.size) {
      return render_load_all_button();
    }
    const x = log.get(index);
    if (x == undefined) {
      return <div style={{ height: "1px" }} />;
    }
    return (
      <LogEntry
        id={x.get("id")}
        cursor={cursor_index === index}
        time={x.get("time")}
        event={x.get("event").toJS()}
        account_id={x.get("account_id")}
        user_map={user_map}
        backgroundStyle={{ background: rowBackground({ index }) }}
        project_id={project_id}
      />
    );
  }

  function file_row_renderer(index): Rendered {
    const files = get_opened_files();
    if (index === files.length) {
      return render_load_all_button();
    }
    const file = files[index];
    if (file == null) {
      return <div style={{ height: "1px" }} />;
    }

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => handleFileEntryClick(e, file.filename, project_id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            handleFileEntryClick(e, file.filename, project_id);
          }
        }}
        style={{
          alignItems: "center",
          background: rowBackground({ index }),
          boxSizing: "border-box",
          cursor: "pointer",
          display: "flex",
          gap: 8,
          maxWidth: "100%",
          minHeight: 36,
          minWidth: 0,
          padding: "6px 10px",
        }}
      >
        <Icon name={file_options(file.filename)?.icon ?? "file"} />
        <span
          title={file.filename}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {file.filename}
        </span>
        <span
          style={{
            color: COLORS.GRAY_M,
            flex: "0 0 auto",
            fontSize: 12,
            maxWidth: "45%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Opened <TimeAgo date={file.time} /> by{" "}
          <User account_id={file.account_id} user_map={user_map} />
        </span>
      </div>
    );
  }

  function render_log_entries(): React.JSX.Element {
    if (state.current.next_cursor_pos) {
      delete state.current.next_cursor_pos;
    }
    return (
      <StatefulVirtuoso
        ref={virtuosoRef}
        totalCount={get_log().size + 1}
        itemContent={row_renderer}
        cacheId={`log-${project_id}`}
        initialTopMostItemIndex={0}
      />
    );
  }

  function render_file_entries(): React.JSX.Element {
    if (state.current.next_cursor_pos) {
      delete state.current.next_cursor_pos;
    }
    return (
      <StatefulVirtuoso
        ref={virtuosoRef}
        totalCount={get_opened_files().length + 1}
        itemContent={file_row_renderer}
        cacheId={`log-files-${project_id}`}
        initialTopMostItemIndex={0}
      />
    );
  }

  function render_log_panel(): React.JSX.Element {
    return (
      <div
        className="smc-vfill"
        style={{
          border: "1px solid #ccc",
          borderRadius: "3px",
          boxSizing: "border-box",
          minWidth: 0,
          overflowX: "hidden",
        }}
      >
        {mode === "files" ? render_file_entries() : render_log_entries()}
      </div>
    );
  }

  function render_body(): React.JSX.Element {
    if (!project_log && project_log_loading) {
      return <Loading theme={"medium"} />;
    }
    if (!project_log && project_log_error) {
      return <div>{project_log_error}</div>;
    }
    return render_log_panel();
  }

  function render_search(): React.JSX.Element | null {
    if (actions == null) return null;
    const openSelectedFile =
      mode === "files"
        ? (_value: string, info: any): void => {
            const file = get_opened_files()[cursor_index];
            if (file == null) return;
            actions.open_file({
              path: file.filename,
              foreground: !info?.ctrl_down,
            });
          }
        : undefined;
    return (
      <LogSearch
        actions={actions}
        search={search}
        selected={mode === "history" ? get_log().get(cursor_index) : undefined}
        onSubmit={openSelectedFile}
        increment_cursor={(): void => {
          increment_cursor();
        }}
        decrement_cursor={(): void => {
          decrement_cursor();
        }}
        reset_cursor={(): void => {
          reset_cursor();
        }}
      />
    );
  }

  function render_mode_toggle(): React.JSX.Element {
    return (
      <Radio.Group
        value={mode}
        onChange={(val) => {
          const next = val.target.value;
          if (isFlyoutLogMode(next)) {
            setMode(next);
            set_cursor_index(0);
            storeFlyoutState(project_id, "log", { mode: next });
          }
        }}
        size="small"
        style={MODE_TOGGLE_STYLE}
      >
        <Radio.Button value="files" style={MODE_TOGGLE_BUTTON_STYLE}>
          {intl.formatMessage(labels.files)}
        </Radio.Button>
        <Radio.Button value="history" style={MODE_TOGGLE_BUTTON_STYLE}>
          {intl.formatMessage(labels.activity)}
        </Radio.Button>
      </Radio.Group>
    );
  }

  function update_deduplicate(next: boolean): void {
    setDeduplicate(next);
    set_cursor_index(0);
    storeFlyoutState(project_id, "log", { deduplicate: next });
  }

  function update_log_filter(filter: FlyoutLogFilter, active: boolean): void {
    const current = logFilter.toJS() as FlyoutLogFilter[];
    const next = (
      active
        ? [...new Set([...current, filter])]
        : current.filter((item) => item !== filter)
    ) as FlyoutLogFilter[];
    setLogFilter(List(next));
    set_cursor_index(0);
    storeFlyoutState(project_id, "log", { logFilter: next });
  }

  function reset_log_filter(): void {
    const next = [...FLYOUT_LOG_FILTER_DEFAULT];
    setLogFilter(List(next));
    set_cursor_index(0);
    storeFlyoutState(project_id, "log", { logFilter: next });
  }

  function render_workspace_toggle(): React.JSX.Element | null {
    if (!workspaces.current) return null;
    return (
      <Space size={6}>
        <Switch
          size="small"
          checked={workspaceOnly}
          onChange={setWorkspaceOnly}
        />
        <span style={{ fontSize: "12px", color: COLORS.GRAY_M }}>
          Only current workspace
        </span>
      </Space>
    );
  }

  function render_file_controls(): React.JSX.Element | null {
    if (mode !== "files") return null;
    const icon: IconName = deduplicate ? "file" : "copy";
    return (
      <Tooltip title="If enabled, duplicate file-open entries are shown. By default, only the most recent open file activity is shown.">
        <Button
          size="small"
          style={!deduplicate ? LOG_FILTER_ACTIVE_BUTTON_STYLE : undefined}
          icon={<Icon name={icon} />}
          onClick={() => update_deduplicate(!deduplicate)}
        >
          Show all
        </Button>
      </Tooltip>
    );
  }

  function render_filter_button({
    active,
    filter,
    icon,
    title,
  }: {
    active: boolean;
    filter: FlyoutLogFilter;
    icon: IconName;
    title: string;
  }): React.JSX.Element {
    return (
      <Tooltip title={title}>
        <Button
          size="small"
          style={active ? LOG_FILTER_ACTIVE_BUTTON_STYLE : undefined}
          icon={<Icon name={icon} />}
          onClick={() => update_log_filter(filter, !active)}
        />
      </Tooltip>
    );
  }

  function render_history_filters(): React.JSX.Element | null {
    if (mode !== "history") return null;
    return (
      <Space.Compact>
        <Tooltip title="Toggle the filter buttons on the right to show or hide specific groups of events. Click this button to reset the filter.">
          <Button size="small" onClick={reset_log_filter}>
            Show:
          </Button>
        </Tooltip>
        {render_filter_button({
          active: showOpenFiles,
          filter: "open",
          icon: "file",
          title: "Show file open events",
        })}
        {render_filter_button({
          active: showFileActions,
          filter: "files",
          icon: "files",
          title: "Show file action events",
        })}
        {render_filter_button({
          active: showProject,
          filter: "project",
          icon: "project-outlined",
          title: "Show project events",
        })}
        {render_filter_button({
          active: showUser,
          filter: "user",
          icon: "users",
          title: "Show user events",
        })}
        {render_filter_button({
          active: showOther,
          filter: "other",
          icon: "solution",
          title: "Show other events",
        })}
      </Space.Compact>
    );
  }

  function active_filter_warning(): React.JSX.Element | null {
    if (mode !== "history") return null;
    if (logFilter.size > 0) return null;

    return (
      <Alert
        type="info"
        banner
        showIcon={false}
        style={{ marginBottom: 8, padding: "8px 12px" }}
        description={
          <>
            <Tooltip title="Reset filter" placement="bottom">
              <Button
                size="small"
                type="text"
                style={{ float: "right", color: COLORS.GRAY_M }}
                onClick={reset_log_filter}
                icon={<Icon name="close-circle-filled" />}
              >
                {intl.formatMessage(labels.reset)}
              </Button>
            </Tooltip>
            <FormattedMessage
              id="page.flyouts.log.filter_message"
              description={"The list of activities is filtered"}
              defaultMessage={"All activities are filtered!"}
            />
          </>
        }
      />
    );
  }

  function render_log_actions(): React.JSX.Element {
    return (
      <Space.Compact>
        <Tooltip title="Refresh log">
          <Button
            size="small"
            icon={<Icon name="refresh" />}
            disabled={!!project_log_deleting}
            loading={!!project_log_loading}
            onClick={() => actions?.refresh_project_log()}
          >
            Refresh
          </Button>
        </Tooltip>
        <Popconfirm
          title="Delete project log?"
          description="This permanently deletes the activity log and cannot be undone."
          okText="Delete"
          okButtonProps={{ danger: true }}
          onConfirm={() => actions?.delete_project_log()}
        >
          <Tooltip title="Delete log">
            <Button
              size="small"
              icon={<Icon name="trash" />}
              danger
              disabled={!!project_log_loading || !!project_log_loading_older}
              loading={!!project_log_deleting}
            >
              Delete
            </Button>
          </Tooltip>
        </Popconfirm>
      </Space.Compact>
    );
  }

  function render_secondary_toolbar(): React.JSX.Element {
    return (
      <Flex
        align="center"
        gap={8}
        justify="space-between"
        wrap
        style={{ marginBottom: 8, minWidth: 0 }}
      >
        <div style={{ flex: "1 1 320px", minWidth: 220 }}>
          {render_search()}
        </div>
        <Space
          size={8}
          wrap
          style={{
            flex: "0 1 auto",
            justifyContent: "flex-end",
            minWidth: 0,
          }}
        >
          {render_workspace_toggle()}
          {render_file_controls()}
          {render_history_filters()}
          {render_log_actions()}
        </Space>
      </Flex>
    );
  }

  return (
    <div
      style={{
        boxSizing: "border-box",
        margin: "auto",
        maxWidth: "100%",
        minWidth: 0,
        overflowX: "hidden",
        padding: "15px",
        width: "1100px",
      }}
      className={"smc-vfill"}
    >
      <>
        <Flex
          align="flex-start"
          justify="space-between"
          wrap
          gap={12}
          style={{ marginBottom: 8 }}
        >
          <h1
            style={{
              flex: "1 1 auto",
              marginTop: "0px",
              marginBottom: 0,
              minWidth: 0,
            }}
          >
            {mode === "files" ? (
              <>
                <Icon name="file" />{" "}
                <FormattedMessage
                  id="project.history.log.recent_files_title"
                  defaultMessage="Recent Files"
                />
              </>
            ) : (
              <>
                <Icon name="history" />{" "}
                <FormattedMessage
                  id="project.history.log.title"
                  defaultMessage="{projectLabel} Activity Log"
                  values={{ projectLabel }}
                />
              </>
            )}
          </h1>
          <Space size={8} style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}>
            {render_mode_toggle()}
            <DiskUsage project_id={project_id} compact />
            <ManagedEgressCompactButton
              project_id={project_id}
              showUsageText={false}
              size="small"
            />
          </Space>
        </Flex>
        {render_secondary_toolbar()}
        {active_filter_warning()}
        {render_body()}
      </>
    </div>
  );
};
