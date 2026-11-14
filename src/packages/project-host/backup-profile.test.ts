import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BackupConfigInvalidatedError,
  BackupConfigs,
  BackupProfiles,
  invalidateBackupConfigReply,
  removeBackupProfile,
} from "./backup-profile";

describe("removeBackupProfile reports what happened to the cached profile", () => {
  let dir: string;
  let profile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "backup-profile-"));
    await mkdir(join(dir, "rustic"));
    profile = join(dir, "rustic", "project-x.toml");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes an existing profile", async () => {
    await writeFile(profile, "[repository]\n", { mode: 0o600 });
    await expect(removeBackupProfile(profile)).resolves.toEqual({
      profile: "removed",
    });
    await expect(stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a missing profile as absent", async () => {
    await expect(removeBackupProfile(profile)).resolves.toEqual({
      profile: "absent",
    });
  });

  it("reports a profile it can't remove as failed, never removed or absent", async () => {
    // a non-empty directory where the file should be: rm fails
    await mkdir(profile);
    await writeFile(join(profile, "x"), "x");
    await expect(removeBackupProfile(profile)).resolves.toMatchObject({
      profile: "failed",
    });
    await expect(stat(profile)).resolves.toBeDefined();
  });

  it("reports a profile it can't even check as failed, never absent", async () => {
    // the parent is a file: lstat fails with ENOTDIR, not ENOENT
    await rm(join(dir, "rustic"), { recursive: true });
    await writeFile(join(dir, "rustic"), "not a directory");
    const result = await removeBackupProfile(profile);
    expect(result.profile).toBe("failed");
    expect((result.error as any)?.code).toBe("ENOTDIR");
  });
});

describe("BackupProfiles fences profiles against an invalidation", () => {
  const PROJECT = "p";
  let dir: string;
  let profile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "backup-profiles-"));
    profile = join(dir, "rustic", "project-p.toml");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("publishes a profile fetched under a current token", async () => {
    const profiles = new BackupProfiles();
    const token = profiles.token(PROJECT);
    await expect(
      profiles.publish({
        project_id: PROJECT,
        token,
        profilePath: profile,
        toml: "t",
      }),
    ).resolves.toBe(true);
    expect((await stat(profile)).mode & 0o777).toBe(0o600);
  });

  it("never publishes a fetch that an invalidation overtook", async () => {
    const profiles = new BackupProfiles();
    // the fetch takes its token, then waits for the hub...
    const token = profiles.token(PROJECT);
    const fetch = deferred();
    const inFlight = (async () => {
      await fetch.promise;
      return await profiles.publish({
        project_id: PROJECT,
        token,
        profilePath: profile,
        toml: "stale",
      });
    })();
    // ...the invalidation completes meanwhile...
    await expect(profiles.invalidate(PROJECT, profile)).resolves.toEqual({
      profile: "absent",
    });
    // ...and then the stale answer arrives
    fetch.resolve();
    await expect(inFlight).resolves.toBe(false);
    await expect(stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(profiles.isCurrent(PROJECT, token)).toBe(false);
  });

  it("takes back a publish that was renaming while the invalidation started, and only then returns", async () => {
    const atRename = deferred();
    const reached = deferred();
    const profiles = new BackupProfiles({
      beforeRename: async () => {
        reached.resolve();
        await atRename.promise;
      },
    });
    const token = profiles.token(PROJECT);
    const publishing = profiles.publish({
      project_id: PROJECT,
      token,
      profilePath: profile,
      toml: "stale",
    });
    await reached.promise; // the temp file is written, the rename is next
    const order: string[] = [];
    const invalidation = profiles
      .invalidate(PROJECT, profile)
      .then((r) => (order.push("invalidated"), r));
    void publishing.then(() => order.push("published"));
    atRename.resolve();
    await expect(publishing).resolves.toBe(false);
    await expect(invalidation).resolves.toEqual({ profile: "absent" });
    // the invalidation returned only after the stale publish was undone
    expect(order).toEqual(["published", "invalidated"]);
    await expect(stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
    // and no temp file is left behind
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dir, "rustic"))).toEqual([]);
  });

  it("takes back a publish that the invalidation overtook just after its rename", async () => {
    let invalidation: Promise<unknown> | undefined;
    const profiles = new BackupProfiles({
      afterRename: async () => {
        // the file is in place; the invalidation starts now
        invalidation = profiles.invalidate(PROJECT, profile);
      },
    });
    const published = await profiles.publish({
      project_id: PROJECT,
      token: profiles.token(PROJECT),
      profilePath: profile,
      toml: "stale",
    });
    expect(published).toBe(false);
    await expect(invalidation).resolves.toEqual({ profile: "absent" });
    await expect(stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes again after the invalidation, under a new token", async () => {
    const profiles = new BackupProfiles();
    const old = profiles.token(PROJECT);
    await profiles.invalidate(PROJECT, profile);
    await expect(
      profiles.publish({
        project_id: PROJECT,
        token: old,
        profilePath: profile,
        toml: "x",
      }),
    ).resolves.toBe(false);
    await expect(
      profiles.publish({
        project_id: PROJECT,
        token: profiles.token(PROJECT),
        profilePath: profile,
        toml: "y",
      }),
    ).resolves.toBe(true);
    await expect(stat(profile)).resolves.toBeDefined();
  });

  it("makes every older token stale on a host-wide invalidation", async () => {
    const profiles = new BackupProfiles();
    const token = profiles.token(PROJECT);
    profiles.invalidateAll();
    expect(profiles.isCurrent(PROJECT, token)).toBe(false);
    await expect(
      profiles.publish({
        project_id: PROJECT,
        token,
        profilePath: profile,
        toml: "x",
      }),
    ).resolves.toBe(false);
  });
});

describe("BackupConfigs: an invalidation stops a fetch already in flight", () => {
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  let dir: string;
  let profilePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "backup-configs-"));
    profilePath = join(dir, "rustic", `project-${PROJECT}.toml`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  function configs(fetch: jest.Mock, profiles?: BackupProfiles): BackupConfigs {
    return new BackupConfigs({
      fetch,
      profilePath: () => profilePath,
      profiles,
      retryMs: 1,
    });
  }

  async function exists(path: string): Promise<boolean> {
    return await stat(path).then(
      () => true,
      () => false,
    );
  }

  it("publishes and caches a configuration", async () => {
    const fetch = jest.fn(async () => ({ toml: "fresh", ttl_seconds: 60 }));
    const c = configs(fetch);
    await expect(c.ensure(PROJECT)).resolves.toBe(profilePath);
    expect(await readFile(profilePath, "utf8")).toBe("fresh");
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    expect(c.cached(PROJECT)?.path).toBe(profilePath);
    await c.ensure(PROJECT);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("an invalidation removes the profile and the cache entry", async () => {
    const fetch = jest.fn(async () => ({ toml: "fresh" }));
    const c = configs(fetch);
    await c.ensure(PROJECT);
    await expect(c.invalidate(PROJECT)).resolves.toEqual({
      profile: "removed",
    });
    expect(await exists(profilePath)).toBe(false);
    expect(c.cached(PROJECT)).toBeUndefined();
    await c.ensure(PROJECT);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the project's", (c: BackupConfigs) => c.invalidate(PROJECT)],
    ["a host-wide", (c: BackupConfigs) => c.invalidate()],
  ])(
    "%s invalidation during the fetch: nothing published, cached or returned",
    async (_label, invalidate) => {
      const answer = deferred<{ toml: string }>();
      const fetch = jest.fn(() => answer.promise);
      const c = configs(fetch);
      const ensured = c.ensure(PROJECT);
      // the fetch is in flight
      await new Promise((r) => setImmediate(r));
      expect(fetch).toHaveBeenCalledTimes(1);
      await invalidate(c);
      answer.resolve({ toml: "stale" });
      await expect(ensured).rejects.toBeInstanceOf(
        BackupConfigInvalidatedError,
      );
      expect(await exists(profilePath)).toBe(false);
      expect(c.cached(PROJECT)).toBeUndefined();
      // not retried with a configuration fetched before the invalidation
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["beforeRename", "afterRename"] as const)(
    "an invalidation at %s: nothing published, cached or returned",
    async (hook) => {
      let c!: BackupConfigs;
      let invalidation: Promise<unknown> | undefined;
      const profiles = new BackupProfiles({
        [hook]: async () => {
          invalidation = c.invalidate(PROJECT);
        },
      });
      const fetch = jest.fn(async () => ({ toml: "stale" }));
      c = configs(fetch, profiles);
      await expect(c.ensure(PROJECT)).rejects.toBeInstanceOf(
        BackupConfigInvalidatedError,
      );
      await invalidation;
      expect(await exists(profilePath)).toBe(false);
      expect(c.cached(PROJECT)).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("an invalidation after the publish succeeded, before ensure goes on: nothing cached or returned", async () => {
    let c!: BackupConfigs;
    // the publish resolves true, then an invalidation (as from the hub) runs
    // before ensure's continuation
    class InvalidatedAfterPublish extends BackupProfiles {
      async publish(opts: Parameters<BackupProfiles["publish"]>[0]) {
        const published = await super.publish(opts);
        expect(published).toBe(true);
        await expect(c.invalidate(PROJECT)).resolves.toEqual({
          profile: "removed",
        });
        return published;
      }
    }
    const fetch = jest.fn(async () => ({ toml: "stale" }));
    c = configs(fetch, new InvalidatedAfterPublish());
    await expect(c.ensure(PROJECT)).rejects.toBeInstanceOf(
      BackupConfigInvalidatedError,
    );
    expect(await exists(profilePath)).toBe(false);
    expect(c.cached(PROJECT)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a host-wide invalidation drops every cached configuration", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const fetch = jest.fn(async (project_id: string) => ({
      toml: `[repository] # ${project_id}`,
      ttl_seconds: 3600,
    }));
    const c = new BackupConfigs({
      fetch,
      profilePath: (project_id) =>
        join(dir, "rustic", `project-${project_id}.toml`),
      retryMs: 1,
    });
    await c.ensure(PROJECT);
    await c.ensure(OTHER);
    expect(c.cached(PROJECT)).toBeDefined();
    expect(c.cached(OTHER)).toBeDefined();
    await expect(c.invalidate()).resolves.toEqual({});
    expect(c.cached(PROJECT)).toBeUndefined();
    expect(c.cached(OTHER)).toBeUndefined();
    // both are fetched again, not served from before the invalidation
    await c.ensure(PROJECT);
    await c.ensure(OTHER);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("a fetch that fails is retried", async () => {
    const fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("unreachable"))
      .mockResolvedValueOnce({ toml: "fresh" });
    const c = configs(fetch);
    await expect(c.ensure(PROJECT)).resolves.toBe(profilePath);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(profilePath, "utf8")).toBe("fresh");
  });

  it("no configuration: nothing published or cached", async () => {
    const c = configs(jest.fn(async () => null));
    await expect(c.ensure(PROJECT)).resolves.toBeNull();
    expect(await exists(profilePath)).toBe(false);
    expect(c.cached(PROJECT)).toBeUndefined();
  });
});

describe("what the host tells the hub about the profile", () => {
  const PROJECT = "22222222-2222-4222-8222-222222222222";
  let dir: string;
  let profilePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "backup-reply-"));
    profilePath = join(dir, "rustic", `project-${PROJECT}.toml`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(["removed", "absent", "failed"])("passes %s through", (profile) => {
    expect(invalidateBackupConfigReply({ profile })).toEqual({
      ok: true,
      profile,
    });
  });

  it.each([
    ["no profile (a host-wide invalidation)", {}],
    ["an unknown profile", { profile: "bogus" }],
    ["a missing result", undefined],
  ])("says only ok for %s, never removed", (_label, result) => {
    expect(invalidateBackupConfigReply(result as any)).toEqual({ ok: true });
  });

  it("never sends the error text", () => {
    expect(
      invalidateBackupConfigReply({
        profile: "failed",
        error: new Error("/secret/path: EACCES"),
      } as any),
    ).toEqual({ ok: true, profile: "failed" });
  });

  describe("from a real invalidation", () => {
    const reply = async (c: BackupConfigs, project_id?: string) =>
      invalidateBackupConfigReply(await c.invalidate(project_id));
    const make = (onRemovalFailed?: jest.Mock) =>
      new BackupConfigs({
        fetch: async () => ({ toml: "[repository]" }),
        profilePath: () => profilePath,
        onRemovalFailed,
      });

    it("removed, once a published profile is gone", async () => {
      const c = make();
      await c.ensure(PROJECT);
      await expect(reply(c, PROJECT)).resolves.toEqual({
        ok: true,
        profile: "removed",
      });
      await expect(stat(profilePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("absent, when there was none", async () => {
      await expect(reply(make(), PROJECT)).resolves.toEqual({
        ok: true,
        profile: "absent",
      });
    });

    it("failed, when it can't be removed; and the failure is reported", async () => {
      // a non-empty directory where the file should be: rm fails
      await mkdir(profilePath, { recursive: true });
      await writeFile(join(profilePath, "x"), "x");
      const onRemovalFailed = jest.fn();
      await expect(reply(make(onRemovalFailed), PROJECT)).resolves.toEqual({
        ok: true,
        profile: "failed",
      });
      expect(onRemovalFailed).toHaveBeenCalledWith(
        expect.objectContaining({ project_id: PROJECT }),
      );
    });

    it("only ok for a host-wide invalidation", async () => {
      const c = make();
      await c.ensure(PROJECT);
      await expect(reply(c)).resolves.toEqual({ ok: true });
    });
  });
});
