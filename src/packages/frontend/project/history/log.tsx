/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex, Popconfirm, Space, Switch } from "antd";
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
import { Icon, Loading } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { get_local_storage, set_local_storage } from "@cocalc/frontend/misc";
import { rowBackground, search_match, search_split } from "@cocalc/util/misc";
import { LogEntry } from "./log-entry";
import { LogSearch } from "./search";
import { EventRecord, to_search_string } from "./types";

interface Props {
  project_id: string;
}

const LOG_WORKSPACE_ONLY_STORAGE_PREFIX = "project-log-workspace-only";

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
  const actions = useActions({ project_id });
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const state = useRef<{
    log?: List<TypedMap<EventRecord>>;
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
    force_update();
  }, [project_log, search, workspaceOnly, workspaces.current]);

  useEffect(() => {
    actions?.refresh_project_log();
  }, [actions, project_id]);

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
        if (paths.length === 0) return false;
        return paths.some(
          (path) =>
            workspaces.resolveWorkspaceForPath(path)?.workspace_id ===
            workspaceId,
        );
      });
    }
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
    if (cursor_index < 0 || cursor_index >= get_log().size) {
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

  function render_log_panel(): React.JSX.Element {
    return (
      <div
        className="smc-vfill"
        style={{ border: "1px solid #ccc", borderRadius: "3px" }}
      >
        {render_log_entries()}
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

  function render_search(): React.JSX.Element | void {
    if (actions == null) return;
    return (
      <LogSearch
        actions={actions}
        search={search}
        selected={get_log().get(cursor_index)}
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

  return (
    <div
      style={{
        padding: "15px",
        width: "1100px",
        maxWidth: "100%",
        margin: "auto",
      }}
      className={"smc-vfill"}
    >
      <>
        <h1 style={{ marginTop: "0px" }}>
          <Icon name="history" />{" "}
          <FormattedMessage
            id="project.history.log.title"
            defaultMessage="{projectLabel} Activity Log"
            values={{ projectLabel }}
          />
        </h1>
        {workspaces.current ? (
          <Flex justify="space-between" style={{ marginBottom: 8 }}>
            <Space size={8}>
              <Switch
                size="small"
                checked={workspaceOnly}
                onChange={setWorkspaceOnly}
              />
              <span style={{ fontSize: "12px", color: "#666" }}>
                Only current workspace
              </span>
            </Space>
            <Space size={8}>
              <Button
                icon={<Icon name="refresh" />}
                disabled={!!project_log_deleting}
                loading={!!project_log_loading}
                onClick={() => actions?.refresh_project_log()}
              >
                Refresh
              </Button>
              <Popconfirm
                title="Delete project log?"
                description="This permanently deletes the activity log and cannot be undone."
                okText="Delete"
                okButtonProps={{ danger: true }}
                onConfirm={() => actions?.delete_project_log()}
              >
                <Button
                  icon={<Icon name="trash" />}
                  danger
                  disabled={
                    !!project_log_loading || !!project_log_loading_older
                  }
                  loading={!!project_log_deleting}
                >
                  Delete Log
                </Button>
              </Popconfirm>
            </Space>
          </Flex>
        ) : (
          <Flex justify="flex-end" style={{ marginBottom: 8 }}>
            <Space size={8}>
              <Button
                icon={<Icon name="refresh" />}
                disabled={!!project_log_deleting}
                loading={!!project_log_loading}
                onClick={() => actions?.refresh_project_log()}
              >
                Refresh
              </Button>
              <Popconfirm
                title="Delete project log?"
                description="This permanently deletes the activity log and cannot be undone."
                okText="Delete"
                okButtonProps={{ danger: true }}
                onConfirm={() => actions?.delete_project_log()}
              >
                <Button
                  icon={<Icon name="trash" />}
                  danger
                  disabled={
                    !!project_log_loading || !!project_log_loading_older
                  }
                  loading={!!project_log_deleting}
                >
                  Delete Log
                </Button>
              </Popconfirm>
            </Space>
          </Flex>
        )}
        {render_search()}
        {render_body()}
      </>
    </div>
  );
};
