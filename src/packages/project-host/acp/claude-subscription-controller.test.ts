/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { claudeSubscriptionContainerArgs } from "./claude-subscription-controller";

jest.mock("@cocalc/backend/podman", () => ({
  mountArg: ({ source, target, readOnly }) =>
    `mount:${source}:${target}:${readOnly === true}`,
}));
jest.mock("../codex/codex-project", () => ({
  ensureProjectContainerRunning: jest.fn(),
}));

test("subscription controller has no project filesystem, secret or network mount", () => {
  const args = claudeSubscriptionContainerArgs({
    name: "claude-controller-test",
    projectId: "00000000-0000-4000-8000-000000000001",
    owner: "123:00000000-0000-4000-8000-000000000002:456",
    rootfs: "/trusted-base-rootfs",
    home: "/private-auth-home",
    managedHarnesses: "/managed-harnesses",
    toolBridgeDirectory: "/private-tool-bridge",
    nodeMounts: { "/managed-node": "/opt/cocalc/bin" },
    uid: 1000,
    gid: 1000,
  });
  expect(args).toContain("--read-only");
  expect(args).toContain("cocalc.runtime=acp");
  expect(args).toContain(
    "cocalc.acp.owner=123:00000000-0000-4000-8000-000000000002:456",
  );
  expect(args).toContain("--network=slirp4netns");
  expect(args).not.toContain("--network=container:project-test");
  expect(args).toContain("mount:/private-auth-home:/home/claude:false");
  expect(args).toContain("mount:/managed-harnesses:/opt/cocalc/harnesses:true");
  expect(args).toContain("mount:/managed-node:/opt/cocalc/bin:true");
  expect(args).toContain(
    "mount:/private-tool-bridge:/run/cocalc/agent-tools:true",
  );
  expect(args).not.toContain("--hide-claude-auth");
  expect(args.join(" ")).not.toMatch(
    /project-home|project-secrets|\/run\/secrets|COCALC_BEARER_TOKEN/,
  );
  expect(args.slice(-3)).toEqual([
    "/trusted-base-rootfs",
    "/opt/cocalc/bin/node",
    "/opt/cocalc/harnesses/claude-code/0.81.1/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
  ]);
});
