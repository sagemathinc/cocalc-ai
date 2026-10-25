/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The calendar and todo views of a file open in the project. They follow the
live document, so an edit in the JSON frame (or by an agent) shows at once.
*/

import { Button } from "antd";
import { useMemo, type ReactNode } from "react";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { parseCalendar } from "@cocalc/util/calendar/cocalc-calendar";
import { parseTodo } from "@cocalc/util/todo/cocalc-todo";
import { Agenda, downloadCalendarIcs } from "../chat-editor/calendar-artifact";
import { FontScale, ParseProblems } from "../chat-editor/list-view-parts";
import { TodoList } from "../chat-editor/todo-artifact";

function Frame({ children }: { children: ReactNode }) {
  // The frame's resolved size: its own zoom, else the account's default.
  const { font_size: fontSize } = useFrameContext();
  return (
    <FontScale fontSize={fontSize}>
      <div
        className="smc-vfill"
        style={{
          minHeight: 0,
          padding: 16,
          overflow: "auto",
          fontSize,
          color: UI_COLORS.text,
          background: UI_COLORS.surface,
        }}
      >
        <div style={{ maxWidth: 900, margin: "0 auto" }}>{children}</div>
      </div>
    </FontScale>
  );
}

function Empty({ what }: { what: string }) {
  const { actions } = useFrameContext();
  return (
    <div role="status" style={{ color: UI_COLORS.secondary }}>
      This {what} is empty.{" "}
      <Button
        type="link"
        size="small"
        style={{ padding: 0 }}
        onClick={() => actions.show_focused_frame_of_type("cm")}
      >
        Edit the JSON
      </Button>
    </div>
  );
}

export function CalendarViewer({ value }: { value?: string }) {
  const { path } = useFrameContext();
  const parsed = useMemo(
    () => (value?.trim() ? parseCalendar(value) : undefined),
    [value],
  );
  const calendar = parsed?.calendar;
  return (
    <Frame>
      {parsed == null && <Empty what="calendar" />}
      {parsed && (
        <ParseProblems
          problems={parsed.problems}
          shown={!!calendar}
          what="calendar"
        />
      )}
      {calendar && (
        <>
          <Button
            size="small"
            style={{ float: "right" }}
            onClick={() => downloadCalendarIcs(calendar, path)}
          >
            Download .ics
          </Button>
          <Agenda calendar={calendar} />
        </>
      )}
    </Frame>
  );
}

export function TodoViewer({ value }: { value?: string }) {
  const parsed = useMemo(
    () => (value?.trim() ? parseTodo(value) : undefined),
    [value],
  );
  const todo = parsed?.todo;
  return (
    <Frame>
      {parsed == null && <Empty what="todo list" />}
      {parsed && (
        <ParseProblems
          problems={parsed.problems}
          shown={!!todo}
          what="todo list"
        />
      )}
      {todo && <TodoList todo={todo} />}
    </Frame>
  );
}
