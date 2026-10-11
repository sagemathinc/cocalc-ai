import assert from "node:assert/strict";
import { test } from "node:test";
import { projectToLocalForwardArgs } from "./reflect-forward-args";

test("exposes a project port locally: local endpoint first (ssh -L)", () => {
  assert.deepEqual(
    projectToLocalForwardArgs({
      sshTarget: "6adb0c79@host.example:2222",
      remotePort: 8080,
      localHost: "127.0.0.1",
      localPort: 9080,
      name: "project-6adb0c79-8080-to-9080",
      compress: true,
    }),
    [
      "forward",
      "create",
      "127.0.0.1:9080",
      "6adb0c79@host.example:2222:8080",
      "--name",
      "project-6adb0c79-8080-to-9080",
      "--compress",
    ],
  );
  assert.deepEqual(
    projectToLocalForwardArgs({
      sshTarget: "p@h",
      remotePort: 80,
      localHost: "127.0.0.1",
      localPort: 80,
      name: " ",
    }),
    ["forward", "create", "127.0.0.1:80", "p@h:80"],
  );
});
