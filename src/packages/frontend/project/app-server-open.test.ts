jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      addProjectHostAuthToUrl: jest.fn(async ({ url }) => url),
      hub: {
        system: {
          inspectProjectAppPrivateHostname: jest.fn(
            async ({ app_id }: { app_id: string }) =>
              app_id === "cocalc-dev-main"
                ? { url: "https://dev-example.cocalc.ai" }
                : undefined,
          ),
        },
      },
    },
  },
}));

jest.mock("./host-url", () => ({
  withProjectHostBase: (_project_id: string, url?: string) =>
    url ? `https://host.example${url}` : url,
}));

import type { AppSpec, ManagedAppStatus } from "@cocalc/conat/project/api/apps";
import {
  buildPrivateHostnameOpenUrl,
  getPrivateProjectAppOpenUrl,
  getProjectAppOpenUrl,
} from "./app-server-open";

describe("getProjectAppOpenUrl", () => {
  it("prefers a reserved private hostname root for proxy-mode apps", async () => {
    const status: ManagedAppStatus = {
      id: "cocalc-dev-main",
      kind: "service",
      state: "running",
      url: "/project-1/proxy/23454/",
    };

    await expect(
      getProjectAppOpenUrl({
        privateHostname: {
          project_id: "project-1",
          app_id: "cocalc-dev-main",
          label: "dev-example",
          hostname: "dev-example.cocalc.ai",
          base_path: "/apps/cocalc-dev-main",
          url: "https://dev-example.cocalc.ai",
          created_by: "account-1",
          created_at: "2026-07-28T00:00:00.000Z",
          updated_at: "2026-07-28T00:00:00.000Z",
        },
        project_id: "project-1",
        status,
      }),
    ).resolves.toBe("https://dev-example.cocalc.ai");
  });

  it("preserves the runtime base path for private port-mode apps", async () => {
    const spec: AppSpec = {
      version: 1,
      id: "jupyterlab",
      kind: "service",
      proxy: {
        base_path: "/apps/jupyterlab",
        open_mode: "port",
      },
    };
    const status: ManagedAppStatus = {
      id: "jupyterlab",
      kind: "service",
      state: "running",
      url: "/project-1/proxy/6002/",
    };

    await expect(
      getProjectAppOpenUrl({
        privateHostname: {
          project_id: "project-1",
          app_id: "jupyterlab",
          label: "dev-jupyter",
          hostname: "dev-jupyter.cocalc.ai",
          base_path: "/apps/jupyterlab",
          url: "https://dev-jupyter.cocalc.ai",
          created_by: "account-1",
          created_at: "2026-07-28T00:00:00.000Z",
          updated_at: "2026-07-28T00:00:00.000Z",
        },
        project_id: "project-1",
        spec,
        status,
      }),
    ).resolves.toBe("https://dev-jupyter.cocalc.ai/project-1/port/6002/");
  });

  it("opens port-mode service apps at the translated port URL", async () => {
    const spec: AppSpec = {
      version: 1,
      id: "jupyterlab",
      title: "JupyterLab",
      kind: "service",
      command: {
        exec: "bash",
        args: ["-lc", "jupyter lab"],
      },
      lifecycle: {
        mode: "managed",
      },
      network: {
        listen_host: "127.0.0.1",
        port: 6002,
        protocol: "http",
      },
      proxy: {
        base_path: "/apps/jupyterlab",
        strip_prefix: true,
        websocket: true,
        open_mode: "port",
        health_path: "/lab",
        readiness_timeout_s: 45,
      },
      wake: {
        enabled: true,
        keep_warm_s: 1800,
        startup_timeout_s: 120,
      },
    };
    const status: ManagedAppStatus = {
      id: "jupyterlab",
      title: "JupyterLab",
      kind: "service",
      state: "running",
      lifecycle_mode: "managed",
      url: "/project-1/proxy/6002/",
      port: 6002,
      pid: 123,
    };

    await expect(
      getProjectAppOpenUrl({
        project_id: "project-1",
        spec,
        status,
      }),
    ).resolves.toBe("https://host.example/project-1/port/6002/");
  });

  it("opens proxy-mode managed service apps at the running status URL", async () => {
    const spec: AppSpec = {
      version: 1,
      id: "rserver",
      title: "RStudio Server",
      kind: "service",
      command: {
        exec: "bash",
        args: ["-lc", "cocalc-rstudio-server"],
      },
      lifecycle: {
        mode: "managed",
      },
      network: {
        listen_host: "127.0.0.1",
        port: 6006,
        protocol: "http",
      },
      proxy: {
        base_path: "/apps/rserver",
        strip_prefix: true,
        websocket: true,
        open_mode: "proxy",
        readiness_timeout_s: 120,
      },
      wake: {
        enabled: true,
        keep_warm_s: 1800,
        startup_timeout_s: 120,
      },
    };
    const status: ManagedAppStatus = {
      id: "rserver",
      title: "RStudio Server",
      kind: "service",
      state: "running",
      lifecycle_mode: "managed",
      url: "/project-1/proxy/6006/",
      port: 6006,
      pid: 123,
    };

    await expect(
      getProjectAppOpenUrl({
        project_id: "project-1",
        spec,
        status,
      }),
    ).resolves.toBe("https://host.example/project-1/proxy/6006/");
  });
});

describe("buildPrivateHostnameOpenUrl", () => {
  const status: ManagedAppStatus = {
    id: "app",
    kind: "service",
    state: "running",
    url: "/project-1/proxy/6002/",
  };

  it("keeps proxy-mode apps at the private hostname root", () => {
    expect(
      buildPrivateHostnameOpenUrl({
        privateHostnameUrl: "https://dev-app.cocalc.ai",
        spec: {
          version: 1,
          id: "app",
          kind: "service",
          proxy: { open_mode: "proxy" },
        },
        status,
      }),
    ).toBe("https://dev-app.cocalc.ai");
  });

  it("rebases port-mode paths onto the private hostname", () => {
    expect(
      buildPrivateHostnameOpenUrl({
        privateHostnameUrl: "https://dev-app.cocalc.ai",
        spec: {
          version: 1,
          id: "app",
          kind: "service",
          proxy: { open_mode: "port" },
        },
        status,
      }),
    ).toBe("https://dev-app.cocalc.ai/project-1/port/6002/");
  });
});

describe("getPrivateProjectAppOpenUrl", () => {
  it("adds current collaborator authentication to the private hostname", async () => {
    await expect(
      getPrivateProjectAppOpenUrl({
        project_id: "project-1",
        app_id: "cocalc-dev-main",
      }),
    ).resolves.toBe("https://dev-example.cocalc.ai");
  });

  it("rejects an app without a reserved private hostname", async () => {
    await expect(
      getPrivateProjectAppOpenUrl({
        project_id: "project-1",
        app_id: "missing",
      }),
    ).rejects.toThrow("is not reserved");
  });
});
