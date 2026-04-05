import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { COCALC_MINIMAL } from "../fullscreen";
import { parse_query } from "@cocalc/sync/table/util";
import { once } from "@cocalc/util/async-utils";
import { redux, Table } from "../app-framework";
import { lite } from "@cocalc/frontend/lite";

declare var DEBUG: boolean;

// Create and register projects table, which gets automatically
// synchronized with the server.
class ProjectsTable extends Table {
  query() {
    const project_id = redux.getStore("page").get("kiosk_project_id");
    if (project_id != null) {
      // In kiosk mode we load only the relevant project.
      const query = parse_query("projects");
      query["projects"][0].project_id = project_id;
      return query;
    } else {
      return "projects";
    }
  }

  _change(table, _keys) {
    // in kiosk mode, merge in the new project table into the known project map
    let project_map;
    const project_id = redux.getStore("page").get("kiosk_project_id");
    const actions = redux.getActions("projects");
    if (project_id != null) {
      let new_project_map;
      project_map = redux.getStore("projects")?.get("project_map");
      if (project_map != null) {
        new_project_map = project_map.merge(table.get());
      } else {
        new_project_map = table.get();
      }
      return actions.setState({ project_map: new_project_map });
    } else {
      return actions.setState({ project_map: table.get() });
    }
  }
}

function initTableError(): void {
  const table = redux.getTable("projects");
  if (!table) return;
  table._table.on("error", (tableError) => {
    redux.getActions("projects").setState({ tableError });
  });
  table._table.on("clear-error", () => {
    redux.getActions("projects").setState({ tableError: undefined });
  });
}

export const refresh_projects_table = reuseInFlight(async () => {
  if (lite) {
    return;
  }
  const project_id = redux.getStore("page").get("kiosk_project_id");
  redux.removeTable("projects");
  if (project_id != null) {
    const table = redux.createTable("projects", ProjectsTable);
    initTableError();
    await once(table._table, "connected");
    return;
  }
  redux.createTable("projects", ProjectsTable);
  initTableError();
  await once(redux.getTable("projects")._table, "connected");
});

async function load_projects(): Promise<void> {
  const table = redux.createTable("projects", ProjectsTable);
  initTableError();
  await once(table._table, "connected");
}

export function init() {
  if (!COCALC_MINIMAL) {
    load_projects();
  }
}

const project_tables = {};
let previous_project_id: string | undefined = undefined;

// This function makes it possible to switch between projects in kiosk mode.
// If the project changes, it also recreates the users table.
// Warning: https://github.com/sagemathinc/cocalc/pull/3985#discussion_r336828374
export async function switch_to_project(project_id: string): Promise<void> {
  redux.getActions("page").setState({ kiosk_project_id: project_id });
  if (previous_project_id !== project_id) {
    const { recreate_users_table } = await import("../users");
    recreate_users_table();
    previous_project_id = project_id;
  }
  const cached_project_table = project_tables[project_id];
  if (cached_project_table) {
    redux.setTable(project_id, cached_project_table);
  } else {
    redux.removeTable("projects");
    const pt = redux.createTable("projects", ProjectsTable);
    project_tables[project_id] = pt;
    await once(redux.getTable("projects")._table, "connected");
  }
}
