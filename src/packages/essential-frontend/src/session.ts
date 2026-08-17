/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import { connect, type Client } from "@cocalc/conat/core/client";
import { initHubApi, type HubApi } from "@cocalc/conat/hub/api";
import { inboxPrefix } from "@cocalc/conat/names";
import {
  ProjectHostClientManager,
  type ProjectHostClientLease,
} from "@cocalc/conat/project-host/client-manager";
import {
  fsClient,
  fsSubject,
  type FilesystemClient,
} from "@cocalc/conat/files/fs";
import { projectApiClient, type ProjectApi } from "@cocalc/conat/project/api";
import { PROJECT_HOST_BROWSER_SESSION_BOOTSTRAP_PATH } from "@cocalc/conat/auth/project-host-browser-session";
import type { AuthBootstrap } from "./api";

const CONNECT_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 2 * 60_000;

export interface ProjectFiles {
  filesystem: FilesystemClient;
  lease: ProjectHostClientLease;
}

export class UltraliteSession {
  readonly accountId: string;
  readonly browserId = crypto.randomUUID();
  readonly hubApi: HubApi;
  private readonly hubClient: Client;
  private readonly projectHosts: ProjectHostClientManager;

  private constructor({
    accountId,
    hubClient,
    hubApi,
    projectHosts,
  }: {
    accountId: string;
    hubClient: Client;
    hubApi: HubApi;
    projectHosts: ProjectHostClientManager;
  }) {
    this.accountId = accountId;
    this.hubClient = hubClient;
    this.hubApi = hubApi;
    this.projectHosts = projectHosts;
  }

  static async open(bootstrap: AuthBootstrap): Promise<UltraliteSession> {
    const accountId = bootstrap.account_id;
    const homeBayUrl = bootstrap.home_bay_url?.replace(/\/+$/, "");
    if (!accountId || !homeBayUrl) {
      throw new Error("The signed-in account has no home bay route.");
    }
    const hubClient = connect({
      address: homeBayUrl,
      inboxPrefix: inboxPrefix({ account_id: accountId }),
      forceNew: true,
      noCache: true,
      reconnection: true,
    });
    try {
      await hubClient.waitUntilSignedIn({ timeout: CONNECT_TIMEOUT_MS });
      const call = async ({
        name,
        args,
        timeout,
      }: {
        name: string;
        args?: any[];
        timeout?: number;
      }) =>
        await callHub({
          client: hubClient,
          account_id: accountId,
          name,
          args,
          timeout,
        });
      const hubApi = initHubApi(call);
      const projectHosts = new ProjectHostClientManager({
        account_id: accountId,
        api: hubApi.hosts,
        createClient: async ({ address, bearer_token }) => {
          const client = connect({
            address,
            inboxPrefix: inboxPrefix({ account_id: accountId }),
            auth: (callback) => callback({ bearer: bearer_token }),
            forceNew: true,
            noCache: true,
            reconnection: true,
          });
          try {
            await client.waitUntilSignedIn({ timeout: CONNECT_TIMEOUT_MS });
            return client;
          } catch (err) {
            client.close();
            throw err;
          }
        },
        resolveAddress: ({ connection, project_id }) => {
          const direct = connection.connect_url?.trim();
          if (direct) return direct;
          if (connection.local_proxy) return `${homeBayUrl}/${project_id}`;
          return;
        },
      });
      return new UltraliteSession({
        accountId,
        hubClient,
        hubApi,
        projectHosts,
      });
    } catch (err) {
      hubClient.close();
      throw err;
    }
  }

  async openProjectHost(
    project_id: string,
    host_id: string,
  ): Promise<ProjectHostClientLease> {
    return await this.projectHosts.getClient({ project_id, host_id });
  }

  async openProjectFiles(
    project_id: string,
    host_id: string,
  ): Promise<ProjectFiles> {
    const lease = await this.openProjectHost(project_id, host_id);
    return {
      lease,
      filesystem: fsClient({
        client: lease.client,
        subject: fsSubject({ project_id }),
      }),
    };
  }

  async openProjectApi(
    project_id: string,
    host_id: string,
  ): Promise<{ api: ProjectApi; lease: ProjectHostClientLease }> {
    const lease = await this.openProjectHost(project_id, host_id);
    return {
      lease,
      api: projectApiClient({ project_id, client: lease.client }),
    };
  }

  async getProjectState(project_id: string) {
    return await this.hubApi.projects.getProjectState({ project_id });
  }

  async prepareProjectHttpUrl({
    host_id,
    project_id,
    url,
  }: {
    host_id: string;
    project_id: string;
    url: string;
  }): Promise<string> {
    const lease = await this.openProjectHost(project_id, host_id);
    const { token } = await this.hubApi.hosts.issueProjectHostAuthToken({
      host_id,
      project_id,
      ttl_seconds: 300,
    });
    const response = await fetch(
      `${lease.address.replace(/\/+$/, "")}${PROJECT_HOST_BROWSER_SESSION_BOOTSTRAP_PATH}`,
      {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Unable to establish the project app session (HTTP ${response.status}).`,
      );
    }
    return routeProjectHttpUrl(lease.address, url);
  }

  async ensureProjectRunning(
    projectId: string,
    onState?: (state: string) => void,
  ): Promise<void> {
    let state = await this.hubApi.projects.getProjectState({
      project_id: projectId,
    });
    if (state.state === "running") return;
    if (state.error) throw new Error(state.error);
    onState?.("Starting project...");
    await this.hubApi.projects.start({
      project_id: projectId,
      autostart: true,
      wait: false,
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      state = await this.hubApi.projects.getProjectState({
        project_id: projectId,
      });
      if (state.state === "running") return;
      if (state.error) throw new Error(state.error);
      onState?.(`Project is ${state.state || "starting"}...`);
    }
    throw new Error("Timed out waiting for the project to start.");
  }

  close(): void {
    this.projectHosts.close();
    this.hubClient.close();
  }
}

function routeProjectHttpUrl(address: string, value: string): string {
  const base = address.replace(/\/+$/, "");
  try {
    const url = new URL(value, "https://project-host.invalid");
    if (
      /^https?:/i.test(value) &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1"
    ) {
      return url.toString();
    }
    return `${base}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return `${base}/${value.replace(/^\/+/, "")}`;
  }
}
