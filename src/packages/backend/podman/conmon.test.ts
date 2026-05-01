import { parseConmonContainerProcesses } from "./conmon";

describe("parseConmonContainerProcesses", () => {
  it("returns live project containers with conmon and child pids", () => {
    const output = [
      "101 1 /usr/bin/conmon --api-version 1 -n project-11111111-1111-4111-8111-111111111111 --full-attach",
      "102 101 /usr/bin/node /opt/cocalc/project/bin/cocalc-project.js",
      "201 1 /usr/bin/conmon --api-version 1 -n unrelated-container --full-attach",
      "202 201 /bin/sh -lc sleep 5",
      "301 1 /usr/bin/conmon --api-version 1 -n project-22222222-2222-4222-8222-222222222222 --full-attach",
    ].join("\n");

    const containers = parseConmonContainerProcesses(output);

    expect(
      containers.get("project-11111111-1111-4111-8111-111111111111"),
    ).toMatchObject({
      name: "project-11111111-1111-4111-8111-111111111111",
      project_id: "11111111-1111-4111-8111-111111111111",
      conmon_pid: 101,
      child_pids: [102],
    });
    expect(containers.get("unrelated-container")).toMatchObject({
      name: "unrelated-container",
      project_id: undefined,
      conmon_pid: 201,
      child_pids: [202],
    });
    expect(containers.has("project-22222222-2222-4222-8222-222222222222")).toBe(
      false,
    );
  });
});
