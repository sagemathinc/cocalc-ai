import { mkdtemp, mkdir, writeFile, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { harnessOwner } from "./harness-reaper";
import {
  CLAUDE_LOGIN_OWNER,
  CLAUDE_LOGIN_RECOVERY,
  reapAbandonedClaudeLogins,
} from "./claude-login-cleanup";
import { stopClaudeLoginContainers } from "./claude-login-runtime";
import { manageClaudeControllerOwnership } from "./claude-subscription-registry";

jest.mock("./claude-login-runtime", () => ({
  stopClaudeLoginContainers: jest.fn(async () => {}),
}));
jest.mock("./claude-subscription-registry", () => ({
  manageClaudeControllerOwnership: jest.fn(async () => "released"),
}));

const binding = {
  projectId: "3807103b-f2f9-4ced-8885-eeb442d623b7",
  accountId: "d62ec7c2-7b5a-49b7-9662-5c280bbac40b",
  holder: "2900a1aa-219a-4b6c-879c-0154d4096a70",
  codeSubmitted: false,
  published: false,
  abandoned: true,
  containment: "podman-v1",
  nativeStarted: true,
};
beforeEach(() => jest.clearAllMocks());

async function record(home: string, value = binding) {
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, CLAUDE_LOGIN_OWNER), await harnessOwner());
  await writeFile(join(home, CLAUDE_LOGIN_RECOVERY), JSON.stringify(value));
}

test("container shutdown precedes release; live and symlink homes are preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "login-reaper-test-"));
  const home = join(root, "cocalc-claude-login-orphan");
  const live = join(root, "cocalc-claude-login-live");
  try {
    await record(home);
    await record(live, { ...binding, abandoned: false });
    await symlink(live, join(root, "cocalc-claude-login-symlink"));
    await reapAbandonedClaudeLogins(root);
    expect(stopClaudeLoginContainers).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(stopClaudeLoginContainers).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(manageClaudeControllerOwnership).mock.invocationCallOrder[0],
    );
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(live)).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one malformed home does not prevent cleanup of another abandoned container", async () => {
  const root = await mkdtemp(join(tmpdir(), "login-reaper-test-"));
  const bad = join(root, "cocalc-claude-login-a");
  const good = join(root, "cocalc-claude-login-b");
  try {
    await mkdir(bad, { mode: 0o700 });
    await writeFile(join(bad, CLAUDE_LOGIN_OWNER), "not-an-owner");
    await record(good);
    await expect(reapAbandonedClaudeLogins(root)).rejects.toThrow(
      "requires retry",
    );
    await expect(stat(good)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(bad)).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy detached grandchild with sanitized environment cannot authorize release", async () => {
  const root = await mkdtemp(join(tmpdir(), "login-reaper-test-"));
  const home = join(root, "cocalc-claude-login-grandchild");
  await record(home);
  await writeFile(
    join(home, CLAUDE_LOGIN_RECOVERY),
    JSON.stringify({
      ...binding,
      containment: undefined,
      nativeStarted: undefined,
    }),
  );
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore',env:{}});
    console.log(child.pid); child.unref();
  `,
    ],
    { env: { CLAUDE_CONFIG_DIR: home }, stdio: "pipe" },
  );
  const closed = once(parent, "close");
  const [chunk] = await once(parent.stdout!, "data");
  const pid = Number(chunk.toString().trim());
  await closed;
  try {
    await expect(reapAbandonedClaudeLogins(root)).rejects.toThrow(
      "requires retry",
    );
    process.kill(pid, 0);
    expect(manageClaudeControllerOwnership).not.toHaveBeenCalled();
    expect(stopClaudeLoginContainers).not.toHaveBeenCalled();
    expect((await stat(home)).isDirectory()).toBe(true);
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown container removal retains the reservation and private home", async () => {
  const root = await mkdtemp(join(tmpdir(), "login-reaper-test-"));
  const home = join(root, "cocalc-claude-login-unknown");
  try {
    await record(home);
    jest
      .mocked(stopClaudeLoginContainers)
      .mockRejectedValueOnce(Error("unknown"));
    await expect(reapAbandonedClaudeLogins(root)).rejects.toThrow(
      "requires retry",
    );
    expect(manageClaudeControllerOwnership).not.toHaveBeenCalled();
    expect((await stat(home)).isDirectory()).toBe(true);
    await reapAbandonedClaudeLogins(root);
    expect(manageClaudeControllerOwnership).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "unused reservations retire; ambiguous exchanges remain quarantined (submitted=%s)",
  async (codeSubmitted) => {
    const root = await mkdtemp(join(tmpdir(), "login-reaper-test-"));
    const home = join(root, "cocalc-claude-login-reserved");
    try {
      await record(home, { ...binding, codeSubmitted });
      if (codeSubmitted) {
        await expect(reapAbandonedClaudeLogins(root)).rejects.toThrow(
          "requires retry",
        );
        expect(manageClaudeControllerOwnership).not.toHaveBeenCalled();
        expect((await stat(home)).isDirectory()).toBe(true);
      } else {
        await reapAbandonedClaudeLogins(root);
        expect(manageClaudeControllerOwnership).toHaveBeenCalledWith({
          ...binding,
          operation: "release",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("reservation journaled before launch can retire without native shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "login-reaper-test-"));
  const home = join(root, "cocalc-claude-login-not-started");
  try {
    await record(home, { ...binding, nativeStarted: false });
    await reapAbandonedClaudeLogins(root);
    expect(stopClaudeLoginContainers).not.toHaveBeenCalled();
    expect(manageClaudeControllerOwnership).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
