jest.mock("./run/rootfs-base", () => ({
  __esModule: true,
  inspect: async () => ({ Config: { Env: ["PATH=/usr/bin"] } }),
}));

import { PROJECT_SECRETS_ENV } from "@cocalc/util/project-secrets";
import {
  getEnvironment,
  normalizeProjectContainerConatServer,
} from "./run/env";

describe("normalizeProjectContainerConatServer", () => {
  it("rewrites localhost to the podman host alias", () => {
    expect(normalizeProjectContainerConatServer("http://localhost:9102")).toBe(
      "http://host.containers.internal:9102",
    );
  });

  it("rewrites 127.0.0.1 to the podman host alias", () => {
    expect(normalizeProjectContainerConatServer("http://127.0.0.1:9102")).toBe(
      "http://host.containers.internal:9102",
    );
  });

  it("leaves non-loopback conat hosts unchanged", () => {
    expect(
      normalizeProjectContainerConatServer("http://router.internal:9102"),
    ).toBe("http://router.internal:9102");
  });

  it("exposes the stable project secrets directory env var", async () => {
    await expect(
      getEnvironment({
        HOME: "/home/user",
        project_id: "11111111-1111-4111-8111-111111111111",
        image: "ubuntu:24.04",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        [PROJECT_SECRETS_ENV]: "/run/secrets/cocalc",
      }),
    );
  });
});
