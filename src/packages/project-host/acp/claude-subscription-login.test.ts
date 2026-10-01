/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  ClaudeSubscriptionLoginService as LoginService,
  verifiedClaudeSubscriptionStatus,
} from "./claude-subscription-login";
import type { ClaudeLoginRuntime } from "./claude-login-runtime";

// Only the test double runs the network-free fixture without a container.
class ClaudeSubscriptionLoginService extends LoginService {
  constructor(
    options: ConstructorParameters<typeof LoginService>[0] & {
      argsPrefix?: string[];
    },
  ) {
    const children = new Map<string, ChildProcess>();
    const environment = (home: string) => ({
      HOME: join(home, "native"),
      CLAUDE_CONFIG_DIR: join(home, "native"),
    });
    const runtime: ClaudeLoginRuntime = {
      async launch(binding) {
        const child = spawn(
          options.cliPath,
          [...(options.argsPrefix ?? []), "auth", "login", "--claudeai"],
          {
            env: environment(binding.home),
            detached: true,
            stdio: "pipe",
          },
        );
        children.set(binding.holder, child);
        return child;
      },
      async status(binding) {
        await runtime.stop(binding);
        return (
          await promisify(execFile)(
            options.cliPath,
            [...(options.argsPrefix ?? []), "auth", "status", "--json"],
            {
              env: environment(binding.home),
              timeout: 2000,
            },
          )
        ).stdout;
      },
      async stop(binding) {
        const child = children.get(binding.holder);
        if (!child || child.exitCode != null || child.signalCode != null)
          return;
        const exited = once(child, "close");
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await exited;
      },
    };
    super({ ...options, runtime: options.runtime ?? runtime });
  }
}

const accountId = "d62ec7c2-7b5a-49b7-9662-5c280bbac40b";
const otherAccountId = "fca177c1-b1d6-4f85-bd89-0afc61f67ed8";
const projectId = "3807103b-f2f9-4ced-8885-eeb442d623b7";
const credentialId = "02bfd0a0-50f1-4378-a7fd-bf87a12a2860";
const fixture = join(__dirname, "fixtures", "claude-login.cjs");

async function waitFor(
  service: ClaudeSubscriptionLoginService,
  id: string,
  state: string,
): Promise<ReturnType<typeof service.status>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = service.status(id, projectId, accountId);
    if (current.state === state) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`Claude login did not reach ${state}`);
}

test.each([false, true])(
  "reconnect retains the credential ID and does not replace a different Claude account (mismatch=%s)",
  async (mismatch) => {
    const publish = jest.fn(async () => {
      if (mismatch) throw Error("Reconnect must use the same Claude account");
      return credentialId;
    });
    const validateReconnect = jest.fn(async () => ({}));
    const service = new ClaudeSubscriptionLoginService({
      cliPath: process.execPath,
      argsPrefix: [fixture],
      publish,
      validateReconnect,
    });
    try {
      const started = await service.start(projectId, accountId, credentialId);
      expect(validateReconnect).toHaveBeenCalledWith({
        projectId,
        accountId,
        credentialId,
      });
      for (
        let i = 0;
        i < 100 &&
        !service.status(started.id, projectId, accountId).verificationUrl;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      service.submitCode(started.id, projectId, accountId, "fixture-code");
      const status = await waitFor(
        service,
        started.id,
        mismatch ? "failed" : "completed",
      );
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          credentialId,
          identity: "subscriber@example.com",
        }),
      );
      if (mismatch) {
        expect(status.error).toContain("same Claude account");
        expect(status.credentialId).toBeUndefined();
      } else expect(status.credentialId).toBe(credentialId);
    } finally {
      await service.close();
    }
  },
);

test("reconnect rejects unavailable credentials before starting sign-in", async () => {
  const publish = jest.fn();
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
    validateReconnect: async () => {
      throw Error("unavailable");
    },
  });
  try {
    await expect(
      service.start(projectId, accountId, credentialId),
    ).rejects.toThrow("unavailable");
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
});

test("existing subscriptions are reconnected under ownership, and publication precedes release", async () => {
  const order: string[] = [];
  const release = jest.fn(async () => {
    order.push("release");
  });
  const reserve = jest.fn(async () => {
    order.push("acquire");
    return release;
  });
  const publish = jest.fn(async () => {
    order.push("publish");
    return credentialId;
  });
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
    validateReconnect: async () => {},
    existingCredential: async () => credentialId,
    reserveReconnect: reserve,
  });
  try {
    const started = await service.start(projectId, accountId);
    expect(reserve).toHaveBeenCalledWith({
      projectId,
      accountId,
      credentialId,
      holder: started.id,
    });
    for (
      let i = 0;
      i < 100 &&
      !service.status(started.id, projectId, accountId).verificationUrl;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    service.submitCode(started.id, projectId, accountId, "fixture-code");
    await waitFor(service, started.id, "completed");
    expect(order).toEqual(["acquire", "publish", "release"]);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId, controllerHolder: started.id }),
    );
  } finally {
    await service.close();
  }
});

test.each([undefined, credentialId])(
  "busy ownership rejects every sign-in before native launch (credential=%s)",
  async (selected) => {
    const publish = jest.fn();
    const service = new ClaudeSubscriptionLoginService({
      cliPath: process.execPath,
      argsPrefix: [fixture],
      publish,
      validateReconnect: async () => {},
      reserveReconnect: async () => {
        throw Error("subscription busy");
      },
    });
    await expect(service.start(projectId, accountId, selected)).rejects.toThrow(
      "subscription busy",
    );
    expect(publish).not.toHaveBeenCalled();
    await service.close();
  },
);

test("first sign-in reserves account ownership and carries the holder through creation", async () => {
  const release = jest.fn(async () => {});
  const reserve = jest.fn(async () => release);
  const publish = jest.fn(async () => credentialId);
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
    reserveReconnect: reserve,
  });
  try {
    const started = await service.start(projectId, accountId);
    expect(reserve).toHaveBeenCalledWith({
      projectId,
      accountId,
      credentialId: undefined,
      holder: started.id,
    });
    for (
      let i = 0;
      i < 100 &&
      !service.status(started.id, projectId, accountId).verificationUrl;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    service.submitCode(started.id, projectId, accountId, "fixture-code");
    await waitFor(service, started.id, "completed");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: undefined,
        controllerHolder: started.id,
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    await service.close();
  }
});

test("login stages outside projects, accepts one code, verifies and cleans up", async () => {
  let publishedHome: string | undefined;
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish: async ({
      projectId: target,
      accountId: owner,
      home,
      identity,
      plan,
    }) => {
      expect(target).toBe(projectId);
      expect(owner).toBe(accountId);
      expect(identity).toBe("subscriber@example.com");
      expect(plan).toBe("max");
      expect((await stat(home)).isDirectory()).toBe(true);
      publishedHome = home;
      return credentialId;
    },
  });
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-inherit";
  try {
    const started = await service.start(projectId, accountId);
    expect(started.state).toBe("pending");
    const waiting = await (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = service.status(started.id, projectId, accountId);
        if (current.verificationUrl) return current;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw Error("provider URL was not reported");
    })();
    expect(waiting.verificationUrl).toBe(
      "https://claude.com/cai/oauth/authorize?state=fixture",
    );
    expect(() => service.status(started.id, projectId, otherAccountId)).toThrow(
      "Unknown Claude sign-in session",
    );
    service.submitCode(started.id, projectId, accountId, "fixture-code");
    expect(() =>
      service.submitCode(started.id, projectId, accountId, "fixture-code"),
    ).toThrow();
    const completed = await waitFor(service, started.id, "completed");
    expect(completed.credentialId).toBe(credentialId);
    expect(() => service.cancel(started.id, projectId, accountId)).toThrow(
      "already completed",
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await stat(publishedHome!).then(
          () => false,
          () => true,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(stat(publishedHome!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("status rejects API billing, no plan, and absent identity", () => {
  const valid = {
    loggedIn: true,
    apiProvider: "firstParty",
    subscriptionType: "pro",
    email: "subscriber@example.com",
  };
  expect(verifiedClaudeSubscriptionStatus(JSON.stringify(valid)).plan).toBe(
    "pro",
  );
  for (const override of [
    { apiKeySource: "ANTHROPIC_API_KEY" },
    { subscriptionType: "free" },
    { email: "" },
    { apiProvider: "bedrock" },
    { loggedIn: false },
  ])
    expect(() =>
      verifiedClaudeSubscriptionStatus(
        JSON.stringify({ ...valid, ...override }),
      ),
    ).toThrow();
});

test.each(["team", "enterprise", "future-plan", "professional", "maximum", ""])(
  "unsupported plan %s gives an actionable explanation",
  (subscriptionType) => {
    expect(() =>
      verifiedClaudeSubscriptionStatus(
        JSON.stringify({
          loggedIn: true,
          apiProvider: "firstParty",
          subscriptionType,
          email: "fixture@example.com",
        }),
      ),
    ).toThrow(
      "Team, Enterprise, and unrecognized plans are not supported. Use an Anthropic API key instead.",
    );
  },
);

test("verification cannot report cancellation after publication starts", async () => {
  let releasePublish!: () => void;
  let enteredPublish!: () => void;
  const entered = new Promise<void>((resolve) => (enteredPublish = resolve));
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish: async () => {
      enteredPublish();
      await new Promise<void>((resolve) => (releasePublish = resolve));
      return credentialId;
    },
  });
  const started = await service.start(projectId, accountId);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (service.status(started.id, projectId, accountId).verificationUrl) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  service.submitCode(started.id, projectId, accountId, "fixture-code");
  try {
    await entered;
    expect(service.status(started.id, projectId, accountId).state).toBe(
      "verifying",
    );
    expect(() => service.cancel(started.id, projectId, accountId)).toThrow(
      "verification is already in progress",
    );
  } finally {
    releasePublish?.();
  }
  expect((await waitFor(service, started.id, "completed")).credentialId).toBe(
    credentialId,
  );
});

test("shutdown cancels pending sign-in and rejects new login attempts", async () => {
  const publish = jest.fn();
  const release = jest.fn(async () => {});
  const service = new ClaudeSubscriptionLoginService({
    cliPath: process.execPath,
    argsPrefix: [fixture],
    publish,
    validateReconnect: async () => {},
    reserveReconnect: async () => release,
  });
  const started = await service.start(projectId, accountId, credentialId);
  await service.close();
  expect(publish).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
  expect(() => service.status(started.id, projectId, accountId)).toThrow(
    "Unknown",
  );
  await expect(service.start(projectId, accountId)).rejects.toThrow("closed");
});

test("unknown launch and shutdown acknowledgements retain ownership and staging home", async () => {
  let home!: string;
  const release = jest.fn(async () => {});
  const publish = jest.fn();
  const runtime: ClaudeLoginRuntime = {
    launch: async (binding) => {
      home = binding.home;
      throw Error("unknown launch");
    },
    status: jest.fn(),
    stop: jest.fn(async () => {
      throw Error("unconfirmed shutdown");
    }),
  };
  const service = new LoginService({
    cliPath: fixture,
    runtime,
    publish,
    reserveReconnect: async () => release,
  });
  try {
    await expect(service.start(projectId, accountId)).rejects.toThrow(
      "unconfirmed shutdown",
    );
    expect(release).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect((await stat(home)).isDirectory()).toBe(true);
  } finally {
    await service.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "shutdown proof gates publication and release (unconfirmed=%s)",
  async (stopFails) => {
    const order: string[] = [];
    let child!: ChildProcess;
    let home!: string;
    const runtime: ClaudeLoginRuntime = {
      async launch(binding) {
        home = binding.home;
        child = spawn(
          process.execPath,
          [fixture, "auth", "login", "--claudeai"],
          {
            env: { HOME: join(home, "native") },
            detached: true,
            stdio: "pipe",
          },
        );
        return child;
      },
      status: async () =>
        JSON.stringify({
          loggedIn: true,
          apiProvider: "firstParty",
          subscriptionType: "pro",
          email: "fixture@example.com",
        }),
      stop: async () => {
        order.push("stop");
        if (stopFails) throw Error("unconfirmed shutdown");
      },
    };
    const service = new LoginService({
      cliPath: fixture,
      runtime,
      reserveReconnect: async () => async () => {
        order.push("release");
      },
      publish: async (options) => {
        expect(options.home).toBe(join(home, "native"));
        expect(order).toEqual(["stop"]);
        order.push("publish");
        return credentialId;
      },
    });
    try {
      const started = await service.start(projectId, accountId);
      for (
        let i = 0;
        i < 100 &&
        !service.status(started.id, projectId, accountId).verificationUrl;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      service.submitCode(started.id, projectId, accountId, "fixture-code");
      await waitFor(service, started.id, stopFails ? "failed" : "completed");
      if (stopFails) {
        expect(order).not.toContain("publish");
        expect(order).not.toContain("release");
        expect((await stat(home)).isDirectory()).toBe(true);
      } else expect(order).toEqual(["stop", "publish", "release"]);
    } finally {
      if (stopFails)
        await expect(service.close()).rejects.toThrow("cleanup failed");
      else await service.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
