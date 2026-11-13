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

function withConfigDir(fn: (configPath: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-auth-grants-"));
  try {
    fn(join(dir, "config.json"), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.deepEqual(readdirSync(dir), ["auth-grants.json"]);
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
