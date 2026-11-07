/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";
import type { ProjectStatus } from "@cocalc/conat/project/runner/state";
import type {
  Configuration,
  LocalPathFunction,
  SshServersFunction,
} from "@cocalc/conat/project/runner/types";
import { getProjectRuntimeMode } from "../runtime-mode";
import { WorkspaceRuntimeBackend } from "./workspace";

export interface RuntimeStartOptions {
  project_id: string;
  config?: Configuration;
  localPath: LocalPathFunction;
  sshServers?: SshServersFunction;
}

export interface RuntimeStopOptions {
  project_id: string;
  localPath: LocalPathFunction;
  sshServers?: SshServersFunction;
  force?: boolean;
}

export interface RuntimeStatusOptions {
  project_id: string;
  localPath: LocalPathFunction;
  sshServers?: SshServersFunction;
}

export interface RuntimeSaveOptions {
  project_id: string;
  rootfs?: boolean;
  home?: boolean;
}

export interface RecoveredProject {
  project_id: string;
  status: ProjectStatus;
}

export interface ProjectRuntimeBackend {
  readonly name: "podman" | "workspace";
  init(): Promise<RecoveredProject[]>;
  start(opts: RuntimeStartOptions): Promise<ProjectStatus>;
  stop(opts: RuntimeStopOptions): Promise<void>;
  status(opts: RuntimeStatusOptions): Promise<ProjectStatus>;
  save(opts: RuntimeSaveOptions): Promise<void>;
  close?(): Promise<void>;
}

class PodmanRuntimeBackend implements ProjectRuntimeBackend {
  readonly name = "podman" as const;

  constructor(private readonly podman: typeof import("./podman")) {}

  async init(): Promise<RecoveredProject[]> {
    await this.podman.cleanupStaleProjectContainers();
    await this.podman.cleanupStaleProjectViews();
    await this.podman.cleanupStaleProjectSecretsHostPaths();
    return [];
  }

  async start(opts: RuntimeStartOptions): Promise<ProjectStatus> {
    return await this.podman.start(opts);
  }

  async stop(opts: RuntimeStopOptions): Promise<void> {
    await this.podman.stop(opts);
  }

  async status(opts: RuntimeStatusOptions): Promise<ProjectStatus> {
    return await this.podman.status(opts);
  }

  async save(opts: RuntimeSaveOptions): Promise<void> {
    await this.podman.save(opts);
  }
}

export async function createProjectRuntimeBackend({
  client,
}: {
  client: Client;
}): Promise<ProjectRuntimeBackend> {
  const mode = getProjectRuntimeMode();
  if (mode === "workspace") {
    return new WorkspaceRuntimeBackend({ client });
  }
  if (mode === "podman") {
    return new PodmanRuntimeBackend(await import("./podman"));
  }
  throw new Error(
    "An embedded project runner cannot start with COCALC_PROJECT_RUNTIME=external",
  );
}
