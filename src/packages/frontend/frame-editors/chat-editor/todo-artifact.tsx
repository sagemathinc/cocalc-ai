/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
An agent's todo list (.todo.json, the cocalc-todo format) published as a file
artifact: its sections, each item with its status, done ones crossed out,
each opening to its details. The agent keeps the file current; the card
reads the saved file and follows on Refresh. Nothing here edits the list.
*/

import {
  CheckCircleFilled,
  CloseCircleOutlined,
  PauseCircleOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { Alert, Button, Checkbox, Progress, Space, Tag } from "antd";
import { useEffect, useMemo, useState } from "react";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { useFileChanges } from "./use-file-changes";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  parseTodo,
  todoGroups,
  todoLinkAllowed,
  todoProgress,
  type CocalcTodo,
  type TodoItem,
  type TodoStatus,
} from "@cocalc/util/todo/cocalc-todo";
import { readableOn } from "./calendar-artifact";
import type { FileArtifactAction } from "./file-artifact";
import { FontScale, ParseProblems } from "./list-view-parts";

const PREVIEW_LIMIT = 1024 * 1024;

const STATUS_LABEL: Record<TodoStatus, string> = {
  todo: "To do",
  doing: "In progress",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

export default function TodoArtifact({
  path,
  historical,
  onToolbarActions,
  fontSize,
}: {
  path: string;
  historical: boolean;
  onToolbarActions?: (actions: FileArtifactAction[]) => void;
  fontSize?: number;
}) {
  const { actions } = useProjectContext();
  const [text, setText] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Follow the file: an agent's edit shows without Refresh.
  useFileChanges(path, () => setRefresh((n) => n + 1));
  useEffect(() => {
    let cancelled = false;
    setError("");
    setLoading(true);
    void (async () => {
      try {
        const fs = actions?.fs();
        if (!fs) throw Error("Project filesystem unavailable");
        const stat = await fs.stat(path);
        if (stat.size > PREVIEW_LIMIT)
          throw Error(
            "Todo list exceeds the 1 MiB preview limit. Open the file to read it.",
          );
        const raw = await fs.readFile(path, "utf8");
        if (!cancelled) setText(typeof raw === "string" ? raw : `${raw}`);
      } catch (err) {
        if (!cancelled) {
          // Never show a list the file no longer has.
          setText(undefined);
          setError(`${err}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, path, refresh]);
  const parsed = useMemo(
    () => (text == null ? undefined : parseTodo(text)),
    [text],
  );
  const todo = parsed?.todo;
  const tools: FileArtifactAction[] = [
    {
      key: "open",
      label: "Open in project",
      icon: "external-link",
      disabled: !actions,
      primary: true,
      onClick: () =>
        void actions?.open_file({ path }).catch((err) => setError(`${err}`)),
    },
    {
      key: "refresh",
      label: "Refresh",
      icon: "refresh",
      disabled: loading,
      onClick: () => setRefresh((n) => n + 1),
    },
  ];
  useEffect(() => {
    onToolbarActions?.(tools);
  }, [onToolbarActions, actions, loading, path]);
  return (
    <FontScale fontSize={fontSize}>
      <div
        className="smc-vfill"
        style={{
          minHeight: 0,
          padding: 12,
          overflow: "auto",
          color: UI_COLORS.text,
          background: UI_COLORS.surface,
          fontSize,
        }}
      >
        {onToolbarActions === undefined && (
          <Space wrap style={{ marginBottom: 8 }}>
            {tools.map((tool) => (
              <Button
                key={tool.key}
                disabled={tool.disabled}
                onClick={tool.onClick}
              >
                {tool.label}
              </Button>
            ))}
          </Space>
        )}
        <div role="status">
          {loading ? "Loading current saved todo list..." : ""}
        </div>
        {historical && (
          <div role="note">
            Published file reference; the list shown is current, not a
            historical snapshot.
          </div>
        )}
        {error && <Alert type="warning" title={error} />}
        {parsed && (
          <ParseProblems
            problems={parsed.problems}
            shown={!!todo}
            what="todo list"
          />
        )}
        {todo && <TodoList todo={todo} />}
      </div>
    </FontScale>
  );
}

export function TodoList({ todo }: { todo: CocalcTodo }) {
  const [hideDone, setHideDone] = useState(false);
  const groups = useMemo(() => todoGroups(todo), [todo]);
  const progress = todoProgress(todo.items);
  const finished = todo.items.filter(
    (item) => item.status === "done" || item.status === "cancelled",
  ).length;
  const counts = (status: TodoStatus) =>
    todo.items.filter((item) => item.status === status).length;
  const updated = todo.updated ? new Date(todo.updated) : undefined;
  return (
    <div>
      <h3 style={{ margin: "0 0 4px", fontSize: "1.3em" }}>{todo.title}</h3>
      {todo.description && <StaticMarkdown value={todo.description} />}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          color: UI_COLORS.secondary,
          margin: "4px 0 8px",
        }}
      >
        <span>
          {progress.done} of {progress.total} done
        </span>
        <Progress
          percent={
            progress.total
              ? Math.round((100 * progress.done) / progress.total)
              : 0
          }
          showInfo={false}
          size="small"
          style={{ width: 120, margin: 0 }}
          aria-label={`${progress.done} of ${progress.total} done`}
        />
        {counts("doing") > 0 && <span>{counts("doing")} in progress</span>}
        {counts("waiting") > 0 && <span>{counts("waiting")} waiting</span>}
        {updated && Number.isFinite(updated.getTime()) && (
          <span>
            Updated <TimeAgo date={updated} />
          </span>
        )}
        {finished > 0 && (
          <Checkbox
            checked={hideDone}
            onChange={(e) => setHideDone(e.target.checked)}
          >
            Hide finished ({finished})
          </Checkbox>
        )}
      </div>
      {groups.length === 0 && <div role="status">Nothing on this list.</div>}
      {groups.map((group, i) => {
        const items = hideDone
          ? group.items.filter(
              (item) => item.status !== "done" && item.status !== "cancelled",
            )
          : group.items;
        const sectionProgress = todoProgress(group.items);
        return (
          <section
            key={group.section?.id ?? `rest-${i}`}
            aria-label={group.section?.title ?? "Other"}
            style={{ marginTop: 12 }}
          >
            {(group.section || groups.length > 1) && (
              <h4 style={{ margin: "0 0 4px", fontSize: "1.1em" }}>
                {group.section?.title ?? "Other"}{" "}
                <span
                  style={{
                    color: UI_COLORS.secondary,
                    fontWeight: 400,
                    fontSize: "0.85em",
                  }}
                >
                  {sectionProgress.done}/{sectionProgress.total}
                </span>
              </h4>
            )}
            {group.section?.description && (
              <div style={{ color: UI_COLORS.secondary }}>
                <StaticMarkdown value={group.section.description} />
              </div>
            )}
            {items.map((item) => (
              <Item key={item.id} item={item} todo={todo} />
            ))}
            {items.length === 0 && (
              <div style={{ color: UI_COLORS.secondary, fontSize: "0.85em" }}>
                All finished.
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function StatusIcon({ status }: { status: TodoStatus }) {
  const label = STATUS_LABEL[status];
  const style = { fontSize: "1em", flexShrink: 0 } as const;
  switch (status) {
    case "done":
      return (
        <CheckCircleFilled
          aria-label={label}
          style={{ ...style, color: UI_COLORS.success }}
        />
      );
    case "doing":
      return (
        <SyncOutlined
          aria-label={label}
          style={{ ...style, color: UI_COLORS.primary }}
        />
      );
    case "waiting":
      return (
        <PauseCircleOutlined
          aria-label={label}
          style={{ ...style, color: UI_COLORS.warning }}
        />
      );
    case "cancelled":
      return (
        <CloseCircleOutlined
          aria-label={label}
          style={{ ...style, color: UI_COLORS.secondary }}
        />
      );
    default:
      // An empty circle, the size of the icons.
      return (
        <span
          role="img"
          aria-label={label}
          style={{
            ...style,
            display: "inline-block",
            width: "1em",
            height: "1em",
            borderRadius: "50%",
            border: `2px solid ${UI_COLORS.secondary}`,
            boxSizing: "border-box",
          }}
        />
      );
  }
}

function Item({ item, todo }: { item: TodoItem; todo: CocalcTodo }) {
  const [open, setOpen] = useState(false);
  const struck = item.status === "done" || item.status === "cancelled";
  const category = item.category ? todo.categories?.[item.category] : undefined;
  const hasMore = !!(item.details || item.links?.length || item.due);
  const titleStyle = {
    textDecoration: struck ? "line-through" : undefined,
    color: item.status === "cancelled" ? UI_COLORS.secondary : undefined,
  } as const;
  return (
    <div
      style={{
        borderLeft: `4px solid ${category?.color ?? UI_COLORS.border}`,
        padding: "4px 8px",
        margin: "4px 0",
        background: item.status === "doing" ? UI_COLORS.selected : undefined,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <StatusIcon status={item.status} />
        <span style={{ flex: 1, minWidth: 0 }}>
          {hasMore ? (
            <Button
              type="link"
              size="small"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              style={{
                padding: 0,
                height: "auto",
                whiteSpace: "normal",
                textAlign: "left",
                ...titleStyle,
              }}
            >
              {item.title}
            </Button>
          ) : (
            <span style={titleStyle}>{item.title}</span>
          )}{" "}
          {category && (
            <Tag
              style={
                category.color
                  ? {
                      background: category.color,
                      borderColor: category.color,
                      color: readableOn(category.color),
                    }
                  : undefined
              }
            >
              {category.label}
            </Tag>
          )}
          {item.priority === "high" && !struck && (
            <Tag color="red">high priority</Tag>
          )}
          {item.status === "waiting" && item.waiting_for && (
            <span style={{ color: UI_COLORS.warning }}>
              {" "}
              waiting for {item.waiting_for}
            </span>
          )}
        </span>
      </div>
      {open && (
        <div style={{ margin: "4px 0 4px 22px" }}>
          {item.due && (
            <div style={{ color: UI_COLORS.secondary }}>Due {item.due}</div>
          )}
          {item.details && <StaticMarkdown value={item.details} />}
          {item.links
            ?.filter((link) => todoLinkAllowed(link.url))
            .map((link) => (
              <div key={link.url}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.label}
                </a>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
