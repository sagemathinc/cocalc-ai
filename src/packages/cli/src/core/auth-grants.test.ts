import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  authGrantsPath,
  clearAuthGrants,
  isoOrNull,
  recordFreshAuth,
  recordSessionGrant,
  recordedAuthStatus,
  renameAuthGrant,
} from "./auth-grants";

function withConfigDir(
  fn: (configPath: string, dir: string) => void | Promise<void>,
): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-auth-grants-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result: void | Promise<void>;
  try {
    result = fn(join(dir, "config.json"), dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
}

const NOW = new Date("2026-11-13T01:00:00.000Z");

test("isoOrNull normalises server timestamps and drops invalid ones", () => {
  assert.equal(isoOrNull("2026-11-13T09:00:00Z"), "2026-11-13T09:00:00.000Z");
  assert.equal(
    isoOrNull(new Date("2026-11-13T09:00:00Z")),
    "2026-11-13T09:00:00.000Z",
  );
  for (const bad of [null, undefined, "", "not a date", 12, {}, []]) {
    assert.equal(isoOrNull(bad), null);
  }
});

test("a login record shows future, past and missing values; unknown is null, not 0", () => {
  withConfigDir((configPath) => {
    recordSessionGrant(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai/",
        session_expires_at: "2026-11-20T01:00:00.000Z",
        fresh_auth_until: "2026-11-13T00:00:00.000Z",
      },
      NOW,
    );
    const status = recordedAuthStatus(
      configPath,
      "prod",
      "https://cocalc.ai",
      NOW,
    );
    assert.equal(status.recorded_at, NOW.toISOString());
    assert.equal(
      status.recorded_session_expires_at,
      "2026-11-20T01:00:00.000Z",
    );
    assert.equal(status.recorded_fresh_auth_until, "2026-11-13T00:00:00.000Z");
    assert.equal(status.session_remaining_s, 7 * 24 * 3600);
    assert.equal(status.fresh_auth_remaining_s, 0); // past: clamped at 0
    assert.equal(status.computed_at, NOW.toISOString());
    assert.match(`${status.recorded_note}`, /this CLI config on this machine/);
    assert.match(`${status.recorded_note}`, /local clock/);

    recordSessionGrant(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai",
        session_expires_at: "garbage",
        fresh_auth_until: null,
      },
      NOW,
    );
    const unknown = recordedAuthStatus(
      configPath,
      "prod",
      "https://cocalc.ai",
      NOW,
    );
    assert.equal(unknown.recorded_session_expires_at, null);
    assert.equal(unknown.session_remaining_s, null);
    assert.equal(unknown.fresh_auth_remaining_s, null);

    const none = recordedAuthStatus(
      configPath,
      "other",
      "https://cocalc.ai",
      NOW,
    );
    assert.equal(none.recorded_at, null);
    assert.equal(none.session_remaining_s, null);
    assert.equal(none.fresh_auth_remaining_s, null);
  });
});

test("a record never describes another site's session", () => {
  withConfigDir((configPath) => {
    recordSessionGrant(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai",
        session_expires_at: "2026-11-20T01:00:00.000Z",
        fresh_auth_until: "2026-11-13T09:00:00.000Z",
      },
      NOW,
    );
    const elsewhere = recordedAuthStatus(
      configPath,
      "prod",
      "https://staging.cocalc.ai",
      NOW,
    );
    assert.equal(elsewhere.recorded_fresh_auth_until, null);
    assert.equal(elsewhere.fresh_auth_remaining_s, null);
    // An elevate against another site does not inherit the session expiry.
    recordFreshAuth(
      configPath,
      "prod",
      {
        api: "https://staging.cocalc.ai",
        fresh_auth_until: "2026-11-13T02:00:00Z",
      },
      NOW,
    );
    const st = recordedAuthStatus(
      configPath,
      "prod",
      "https://staging.cocalc.ai",
      NOW,
    );
    assert.equal(st.recorded_session_expires_at, null);
    assert.equal(st.fresh_auth_remaining_s, 3600);
  });
});

test("elevate keeps the session expiry; a failed elevate (null) clears the fresh window", () => {
  withConfigDir((configPath) => {
    recordSessionGrant(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai",
        session_expires_at: "2026-11-20T01:00:00.000Z",
        fresh_auth_until: null,
      },
      NOW,
    );
    recordFreshAuth(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai",
        fresh_auth_until: "2026-11-13T09:00:00.000Z",
      },
      NOW,
    );
    let st = recordedAuthStatus(configPath, "prod", "https://cocalc.ai", NOW);
    assert.equal(st.recorded_session_expires_at, "2026-11-20T01:00:00.000Z");
    assert.equal(st.fresh_auth_remaining_s, 8 * 3600);
    recordFreshAuth(
      configPath,
      "prod",
      { api: "https://cocalc.ai", fresh_auth_until: null },
      NOW,
    );
    st = recordedAuthStatus(configPath, "prod", "https://cocalc.ai", NOW);
    assert.equal(st.recorded_fresh_auth_until, null);
    assert.equal(st.fresh_auth_remaining_s, null);
    assert.equal(st.recorded_session_expires_at, "2026-11-20T01:00:00.000Z");
  });
});

test("rename moves the record; clear removes it; the file goes when empty", () => {
  withConfigDir((configPath) => {
    const grant = {
      api: "https://cocalc.ai",
      session_expires_at: "2026-11-20T01:00:00.000Z",
      fresh_auth_until: "2026-11-13T09:00:00.000Z",
    };
    recordSessionGrant(configPath, "a", grant, NOW);
    recordSessionGrant(configPath, "stale-b", grant, NOW);
    renameAuthGrant(configPath, "a", "b");
    assert.equal(
      recordedAuthStatus(configPath, "a", "https://cocalc.ai", NOW).recorded_at,
      null,
    );
    assert.equal(
      recordedAuthStatus(configPath, "b", "https://cocalc.ai", NOW).recorded_at,
      NOW.toISOString(),
    );
    clearAuthGrants(configPath, ["b", "stale-b"]);
    assert.equal(
      recordedAuthStatus(configPath, "b", "https://cocalc.ai", NOW).recorded_at,
      null,
    );
    assert.throws(() => statSync(authGrantsPath(configPath)));
  });
});

test("the sidecar is 0600, written without leftovers, and holds timestamps only", () => {
  withConfigDir((configPath, dir) => {
    recordSessionGrant(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai",
        session_expires_at: "2026-11-20T01:00:00.000Z",
        fresh_auth_until: "2026-11-13T09:00:00.000Z",
      },
      NOW,
    );
    const path = authGrantsPath(configPath);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["config.auth-grants.json"]);
    const text = readFileSync(path, "utf8");
    for (const key of [
      "cookie",
      "remember_me",
      "api_key",
      "bearer",
      "hub_password",
      "hash",
      "token",
      "secret",
    ]) {
      assert.equal(text.includes(key), false, key);
    }
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed.grants.prod).sort(), [
      "api",
      "fresh_auth_until",
      "recorded_at",
      "session_expires_at",
    ]);
  });
});

test("a corrupt or foreign sidecar reads as unknown and never throws", () => {
  withConfigDir((configPath) => {
    writeFileSync(authGrantsPath(configPath), "{not json");
    const st = recordedAuthStatus(configPath, "prod", "https://cocalc.ai", NOW);
    assert.equal(st.recorded_at, null);
    assert.equal(st.fresh_auth_remaining_s, null);
    writeFileSync(
      authGrantsPath(configPath),
      JSON.stringify({
        grants: {
          prod: {
            api: "https://cocalc.ai",
            recorded_at: "x",
            session_expires_at: "Invalid Date",
            fresh_auth_until: 5,
          },
        },
      }),
    );
    const odd = recordedAuthStatus(
      configPath,
      "prod",
      "https://cocalc.ai",
      NOW,
    );
    assert.equal(odd.recorded_at, null);
    assert.equal(odd.recorded_session_expires_at, null);
    assert.equal(odd.recorded_fresh_auth_until, null);
    // recording over a corrupt file works
    writeFileSync(authGrantsPath(configPath), "{not json");
    recordFreshAuth(
      configPath,
      "prod",
      { api: "https://cocalc.ai", fresh_auth_until: "2026-11-13T02:00:00Z" },
      NOW,
    );
    assert.equal(
      recordedAuthStatus(configPath, "prod", "https://cocalc.ai", NOW)
        .fresh_auth_remaining_s,
      3600,
    );
  });
});

test("a write re-reads the sidecar: another profile's record written meanwhile survives", () => {
  withConfigDir((configPath) => {
    recordSessionGrant(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai",
        session_expires_at: null,
        fresh_auth_until: null,
      },
      NOW,
    );
    // another process records "staging" while this one waits
    recordSessionGrant(
      configPath,
      "staging",
      {
        api: "https://staging.cocalc.ai",
        session_expires_at: "2026-11-20T01:00:00.000Z",
        fresh_auth_until: null,
      },
      NOW,
    );
    recordFreshAuth(
      configPath,
      "prod",
      { api: "https://cocalc.ai", fresh_auth_until: "2026-11-13T02:00:00Z" },
      NOW,
    );
    assert.equal(
      recordedAuthStatus(
        configPath,
        "staging",
        "https://staging.cocalc.ai",
        NOW,
      ).recorded_session_expires_at,
      "2026-11-20T01:00:00.000Z",
    );
  });
});

test("two config files in the same directory never share records (review R1)", () => {
  withConfigDir((_configPath, dir) => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    assert.notEqual(authGrantsPath(a), authGrantsPath(b));
    const grant = {
      api: "https://cocalc.ai",
      session_expires_at: "2026-11-20T01:00:00.000Z",
      fresh_auth_until: "2026-11-13T09:00:00.000Z",
    };
    recordSessionGrant(a, "prod", grant, NOW);
    recordSessionGrant(b, "prod", grant, NOW);
    assert.equal(
      recordedAuthStatus(b, "prod", "https://cocalc.ai", NOW).recorded_at,
      NOW.toISOString(),
    );
    clearAuthGrants(a, ["prod"]); // a's logout
    assert.equal(
      recordedAuthStatus(a, "prod", "https://cocalc.ai", NOW).recorded_at,
      null,
    );
    assert.equal(
      recordedAuthStatus(b, "prod", "https://cocalc.ai", NOW).recorded_at,
      NOW.toISOString(),
    );
  });
});

test("concurrent writer processes never lose each other's records (review R2)", () => {
  return withConfigDir((configPath, dir) => {
    const { spawn } =
      require("node:child_process") as typeof import("node:child_process");
    const modulePath = require.resolve("./auth-grants");
    const n = 8;
    // Each child records its own profile 3 times; all start at once.
    const childScript = join(dir, "writer.js");
    writeFileSync(
      childScript,
      [
        `const g = require(${JSON.stringify(modulePath)});`,
        "const [cfg, name] = process.argv.slice(2);",
        "for (let i = 0; i < 3; i++) {",
        "  g.recordSessionGrant(cfg, name, {",
        '    api: "https://cocalc.ai",',
        '    session_expires_at: "2026-11-20T01:00:00.000Z",',
        "    fresh_auth_until: null,",
        "  });",
        "}",
      ].join("\n"),
    );
    return Promise.all(
      Array.from(
        { length: n },
        (_, i) =>
          new Promise<{ code: number | null; stderr: string }>((resolve) => {
            const child = spawn(process.execPath, [
              childScript,
              configPath,
              `p${i}`,
            ]);
            let stderr = "";
            child.stderr.on("data", (d) => (stderr += d));
            child.on("close", (code) => resolve({ code, stderr }));
          }),
      ),
    ).then((results) => {
      for (const r of results) {
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stderr, "");
      }
      const grants = JSON.parse(
        readFileSync(authGrantsPath(configPath), "utf8"),
      ).grants;
      assert.deepEqual(
        Object.keys(grants).sort(),
        Array.from({ length: n }, (_, i) => `p${i}`).sort(),
      );
      assert.throws(() => statSync(`${authGrantsPath(configPath)}.lock`));
    });
  });
});

test("a held lock skips the update with a warning; a stale lock is removed", () => {
  withConfigDir((configPath) => {
    const lock = `${authGrantsPath(configPath)}.lock`;
    writeFileSync(lock, "");
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      writes.push(`${chunk}`);
      return true;
    };
    try {
      recordSessionGrant(
        configPath,
        "prod",
        {
          api: "https://cocalc.ai",
          session_expires_at: null,
          fresh_auth_until: null,
        },
        NOW,
      );
    } finally {
      (process.stderr as any).write = orig;
    }
    assert.ok(writes.some((w) => w.includes("could not update")));
    assert.equal(
      recordedAuthStatus(configPath, "prod", "https://cocalc.ai", NOW)
        .recorded_at,
      null,
    );
    // a lock left by a crashed writer (old mtime) is taken over
    const old = new Date(Date.now() - 60_000);
    require("node:fs").utimesSync(lock, old, old);
    recordSessionGrant(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai",
        session_expires_at: null,
        fresh_auth_until: null,
      },
      NOW,
    );
    assert.equal(
      recordedAuthStatus(configPath, "prod", "https://cocalc.ai", NOW)
        .recorded_at,
      NOW.toISOString(),
    );
    assert.throws(() => statSync(lock));
  });
});

test("profile names like __proto__ and constructor are plain keys (vanta V1)", () => {
  withConfigDir((configPath) => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      assert.equal(
        recordedAuthStatus(configPath, name, "https://cocalc.ai", NOW)
          .recorded_at,
        null,
        name,
      );
      recordSessionGrant(
        configPath,
        name,
        {
          api: "https://cocalc.ai",
          session_expires_at: null,
          fresh_auth_until: "2026-11-13T02:00:00Z",
        },
        NOW,
      );
      assert.equal(
        recordedAuthStatus(configPath, name, "https://cocalc.ai", NOW)
          .fresh_auth_remaining_s,
        3600,
        name,
      );
    }
    renameAuthGrant(configPath, "constructor", "x");
    clearAuthGrants(configPath, ["toString"]);
    const grants = JSON.parse(
      readFileSync(authGrantsPath(configPath), "utf8"),
    ).grants;
    assert.deepEqual(Object.keys(grants).sort(), ["__proto__", "x"]);
  });
});

test("recordFreshAuth writes nothing when the session is no longer current (review R3)", () => {
  withConfigDir((configPath) => {
    recordSessionGrant(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai",
        session_expires_at: "2026-11-20T01:00:00.000Z",
        fresh_auth_until: null,
      },
      NOW,
    );
    recordFreshAuth(
      configPath,
      "prod",
      {
        api: "https://cocalc.ai",
        fresh_auth_until: "2026-11-13T09:00:00.000Z",
      },
      NOW,
      () => false,
    );
    assert.equal(
      recordedAuthStatus(configPath, "prod", "https://cocalc.ai", NOW)
        .recorded_fresh_auth_until,
      null,
    );
  });
});
