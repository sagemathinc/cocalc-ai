import type { TasksHostServices } from "./host";
import type { TasksMarkdownSurface } from "./markdown";
import type { TasksSessionProvider } from "./session";
import type { TasksTimeTravelProvider } from "./timetravel";

export interface TasksAppCapabilities {
  export: boolean;
  import: boolean;
  cli: boolean;
  syncSession: boolean;
  timeTravel?: boolean;
}

export interface TasksAppDependencies {
  markdown: TasksMarkdownSurface;
  host: TasksHostServices;
  sessionProvider?: TasksSessionProvider;
  timeTravelProvider?: TasksTimeTravelProvider;
}

export interface TasksAppManifest {
  app: "tasks";
  kind: "document-app";
  fileExtensions: readonly ["tasks", ...string[]];
  capabilities: TasksAppCapabilities;
}
