jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      addProjectHostAuthToUrl: jest.fn(async ({ url }) => url),
    },
  },
}));

jest.mock("./host-url", () => ({
  withProjectHostBase: (_project_id: string, url?: string) =>
    url ? `https://host.example${url}` : url,
}));

import type { AppSpec, ManagedAppStatus } from "@cocalc/conat/project/api/apps";
import { getProjectAppOpenUrl } from "./app-server-open";

describe("getProjectAppOpenUrl", () => {
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
});
