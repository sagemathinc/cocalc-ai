import type { EventEmitter } from "events";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { COCALC_MINIMAL } from "../fullscreen";
import { parse_query } from "@cocalc/sync/table/util";
import { once } from "@cocalc/util/async-utils";
import { redux, Table } from "../app-framework";
import { getLogger } from "@cocalc/frontend/logger";

declare var DEBUG: boolean;

const log = getLogger("projects:table");
const PROJECTS_TABLE_CONNECT_TIMEOUT_MS = 15_000;
const PROJECTS_TABLE_CONNECT_ATTEMPTS = 2;

interface ProjectsTableConnection extends EventEmitter {
  get_state?: () => string | undefined;
}

// Create and register projects table, which gets automatically
// synchronized with the server.
export class ProjectsTable extends Table {
  no_changefeed() {
    return true;
  }

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
    const project_id = redux.getStore("page").get("kiosk_project_id");
    const actions = redux.getActions("projects");
    void actions.ensureRealtimeFeedForCurrentAccount?.();
    if (actions.applyProjectsTableSnapshot != null) {
      return actions.applyProjectsTableSnapshot(table.get(), {
        mergeIntoExisting: project_id != null,
        removeMissingProjectIds: project_id != null ? [project_id] : undefined,
      });
    }
    // Fallback for tests or older callers.
    if (project_id != null) {
      const project_map = redux.getStore("projects")?.get("project_map");
      const incomingProjectMap = table.get();
      return actions.setState({
        project_map:
          project_map != null
            ? incomingProjectMap.has(project_id)
              ? project_map.merge(incomingProjectMap)
              : project_map.remove(project_id)
            : incomingProjectMap,
      });
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

async function waitForProjectsTableConnected(
  table: ProjectsTableConnection,
): Promise<boolean> {
  if (table.get_state?.() === "connected") {
    return true;
  }
  try {
    await once(table, "connected", PROJECTS_TABLE_CONNECT_TIMEOUT_MS);
    return true;
  } catch (err) {
    log.info("projects table did not connect cleanly", err);
    return false;
  }
}

async function createProjectsTableUntilConnected(): Promise<void> {
  for (let attempt = 1; attempt <= PROJECTS_TABLE_CONNECT_ATTEMPTS; attempt++) {
    const table = redux.createTable("projects", ProjectsTable);
    initTableError();
    if (await waitForProjectsTableConnected(table._table)) {
      return;
    }
    if (attempt < PROJECTS_TABLE_CONNECT_ATTEMPTS) {
      redux.removeTable("projects");
    }
  }
}

export const refresh_projects_table = reuseInFlight(async () => {
  redux.removeTable("projects");
  await createProjectsTableUntilConnected();
});

async function load_projects(): Promise<void> {
  await createProjectsTableUntilConnected();
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
    await waitForProjectsTableConnected(redux.getTable("projects")._table);
  }
}
