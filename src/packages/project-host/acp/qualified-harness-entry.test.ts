/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { readFile } from "node:fs/promises";
import { qualifiedHarnessLaunch } from "./qualified-harness-entry";

const mockCloseBridge = jest.fn();
const mockCreateBridge = jest.fn();

jest.mock("./credential-relay-bridge", () => ({
  createCredentialRelayBridge: (...args) => mockCreateBridge(...args),
}));

jest.mock("node:fs/promises", () => ({ readFile: jest.fn() }));

const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
  mockCloseBridge.mockResolvedValue(undefined);
  mockCreateBridge.mockResolvedValue({
    baseUrl: "http://127.0.0.1:12345",
    close: mockCloseBridge,
  });
});

test("materializes only an ephemeral relay capability for account keys", async () => {
  mockReadFile.mockResolvedValue(" relay-token \n");
  const launch = await qualifiedHarnessLaunch(
    "claude-code",
    "0.81.1",
    "account-api-key",
  );
  expect(mockReadFile).toHaveBeenCalledWith(
    "/run/cocalc/credential-relay/token",
    { encoding: "utf8", flag: "r" },
  );
  expect(mockCreateBridge).toHaveBeenCalledWith({
    socketPath: "/run/cocalc/credential-relay/relay.sock",
    token: "relay-token",
  });
  expect(launch.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:12345");
  expect(launch.env.ANTHROPIC_API_KEY).toBe("cocalc-credential-relay");
  await launch.close();
  expect(mockCloseBridge).toHaveBeenCalledTimes(1);
});

test("materializes a project-owned key only in the child environment", async () => {
  mockReadFile.mockResolvedValue(" project-key \n");
  const launch = await qualifiedHarnessLaunch("claude-code", "0.81.1");
  expect(mockReadFile).toHaveBeenCalledWith(
    "/run/secrets/cocalc/ANTHROPIC_API_KEY",
    { encoding: "utf8", flag: "r" },
  );
  expect(launch.executable).toMatch(/claude-agent-acp$/);
  expect(launch.args).toEqual(["--hide-claude-auth"]);
  expect(launch.env.ANTHROPIC_API_KEY).toBe("project-key");
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("rejects unknown revisions and missing project credentials", async () => {
  await expect(qualifiedHarnessLaunch("claude-code", "latest")).rejects.toThrow(
    "not available",
  );
  mockReadFile.mockResolvedValue(" \n");
  await expect(qualifiedHarnessLaunch("claude-code", "0.81.1")).rejects.toThrow(
    "Project secret ANTHROPIC_API_KEY is invalid",
  );
});
