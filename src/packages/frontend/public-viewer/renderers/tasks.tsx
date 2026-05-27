/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { JSX } from "react";
import { useMemo, useState } from "react";
import { Alert, Checkbox } from "antd";
import { fromJS, Map } from "immutable";
import TaskList from "@cocalc/frontend/editors/task-editor/list";
import { cmp } from "@cocalc/util/misc";
import { from_str } from "@cocalc/sync/editor/db/doc";
import type { Tasks } from "@cocalc/frontend/editors/task-editor/types";

const SHOW_DONE_STYLE = {
  fontSize: "12pt",
  color: "#666",
  padding: "5px 15px",
  borderBottom: "1px solid lightgrey",
} as const;

export default function PublicViewerTasksRenderer({
  content,
  path,
  project_id,
  fontSize,
}: {
  content: string;
  path: string;
  project_id?: string;
  fontSize?: number;
}): JSX.Element {
  const [showDone, setShowDone] = useState(false);
  const parsed = useMemo(() => {
    try {
      return from_str(content, ["task_id"], ["desc"]);
    } catch (err) {
      return err as Error;
    }
  }, [content]);

  if (parsed instanceof Error) {
    return (
      <Alert
        type="error"
        showIcon
        message="Unable to parse tasks"
        description={`${parsed}`}
      />
    );
  }

  let tasks: Tasks = Map();
  const visibleRows: [number | undefined, string][] = [];
  parsed.get().forEach((task) => {
    const task_id = task.get("task_id");
    tasks = tasks.set(task_id, task);
    if ((showDone || !task.get("done")) && !task.get("deleted")) {
      visibleRows.push([task.get("last_edited"), task_id]);
    }
  });
  visibleRows.sort((a, b) => -cmp(a[0], b[0]));
  const visible = fromJS(visibleRows.map((x) => x[1]));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflowY: "hidden",
      }}
    >
      <div style={SHOW_DONE_STYLE}>
        <Checkbox checked={showDone} onChange={() => setShowDone(!showDone)}>
          Show finished tasks
        </Checkbox>
      </div>
      <TaskList
        path={path}
        project_id={project_id ?? ""}
        tasks={tasks}
        visible={visible}
        read_only={true}
        font_size={fontSize ?? 14}
      />
    </div>
  );
}
