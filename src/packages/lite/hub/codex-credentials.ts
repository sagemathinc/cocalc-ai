import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codexAuthJsonToAppServerLogin } from "@cocalc/ai/acp";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";

export function resolveLiteCodexHome(): string {
  return (
    process.env.COCALC_CODEX_HOME?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    join(
      process.env.COCALC_ORIGINAL_HOME || process.env.HOME || process.cwd(),
      ".codex",
    )
  );
}

export type LiteCredentialTarget = { credentialId?: string; create?: boolean };
type RecordRow = {
  id: string;
  owner: string;
  payload: string;
  revision: string;
  label: string;
  created: number;
  updated: number;
  last_used: number | null;
  revoked: number | null;
};

export function validateLiteSubscriptionAuth(content: string) {
  if (!content?.trim() || Buffer.byteLength(content, "utf8") > 2_000_000) {
    throw Error("ChatGPT auth file must contain at most 2 MB of JSON.");
  }
  const login = codexAuthJsonToAppServerLogin(content);
  if (login?.type !== "chatgptAuthTokens") {
    throw Error(
      "The auth file does not contain a usable ChatGPT subscription.",
    );
  }
  return login;
}

// Local/Plus only: secrets never enter the generic, browser-queryable data table.
// The private directory also protects SQLite journal and WAL files.
function withRegistry<T>(owner: string, fn: (db: DatabaseSync) => T): T {
  if (!owner) throw Error("account id is required");
  const root = join(resolveLiteCodexHome(), "cocalc-subscriptions");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const filename = join(root, "credentials.sqlite3");
  const db = new DatabaseSync(filename);
  try {
    chmodSync(filename, 0o600);
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL,
        revision TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        created INTEGER NOT NULL, updated INTEGER NOT NULL,
        last_used INTEGER, revoked INTEGER,
        refresh_lease TEXT, refresh_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY);
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT id FROM migration WHERE id=1").get()) {
        let raw: string | undefined;
        try {
          raw = readFileSync(join(resolveLiteCodexHome(), "auth.json"), "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        if (
          raw &&
          codexAuthJsonToAppServerLogin(raw)?.type === "chatgptAuthTokens"
        )
          insert(db, owner, raw);
        // A tombstone prevents revoke from re-importing the preserved CLI file.
        // This marker is global intentionally: Lite/Plus has one local user,
        // and the original CLI credential must not be claimed by another owner.
        db.prepare("INSERT INTO migration(id) VALUES(1)").run();
      }
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }
}

export function getLiteCliApiKey(): string | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(resolveLiteCodexHome(), "auth.json"), "utf8"),
    );
    return typeof parsed.OPENAI_API_KEY === "string"
      ? parsed.OPENAI_API_KEY.trim() || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

function insert(db: DatabaseSync, owner: string, payload: string): string {
  const identity = validateLiteSubscriptionAuth(payload).chatgptAccountId;
  const active = db
    .prepare(
      "SELECT payload FROM credentials WHERE owner=? AND revoked IS NULL",
    )
    .all(owner) as Array<{ payload: string }>;
  if (
    active.some(
      (row) =>
        validateLiteSubscriptionAuth(row.payload).chatgptAccountId === identity,
    )
  ) {
    throw Error(
      "This ChatGPT subscription is already connected. Use Reconnect to update it.",
    );
  }
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO credentials
    (id, owner, payload, revision, created, updated) VALUES(?, ?, ?, ?, ?, ?)`,
  ).run(id, owner, payload, randomUUID(), now, now);
  return id;
}

function getActive(db: DatabaseSync, owner: string, id?: string): RecordRow {
  const row = (
    id
      ? db
          .prepare(
            "SELECT * FROM credentials WHERE owner=? AND id=? AND revoked IS NULL",
          )
          .get(owner, id)
      : db
          .prepare(
            "SELECT * FROM credentials WHERE owner=? AND revoked IS NULL AND id=(SELECT id FROM credentials WHERE owner=? ORDER BY rowid LIMIT 1)",
          )
          .get(owner, owner)
  ) as RecordRow | undefined;
  if (!row)
    throw Error(
      "The selected ChatGPT subscription is unavailable. Reconnect or select another subscription.",
    );
  return row;
}

export function resolveLiteCredentialTarget(
  owner: string,
  target: LiteCredentialTarget,
): LiteCredentialTarget {
  if (target.create && target.credentialId)
    throw Error("Choose Add or Reconnect, not both.");
  return withRegistry(owner, (db) => {
    if (target.create) return { create: true };
    if (target.credentialId) {
      getActive(db, owner, target.credentialId);
      return { credentialId: target.credentialId, create: false };
    }
    // Legacy clients must never silently overwrite an existing subscription.
    return { create: true };
  });
}

export function saveLiteCredential(
  owner: string,
  content: string,
  target: LiteCredentialTarget = {},
): string {
  const login = validateLiteSubscriptionAuth(content);
  const resolved = resolveLiteCredentialTarget(owner, target);
  return withRegistry(owner, (db) => {
    if (!resolved.credentialId) return insert(db, owner, content);
    const current = getActive(db, owner, resolved.credentialId);
    if (
      validateLiteSubscriptionAuth(current.payload).chatgptAccountId !==
      login.chatgptAccountId
    ) {
      throw Error(
        "Reconnect must use the same ChatGPT account. Use Add for another subscription.",
      );
    }
    const result = db
      .prepare(
        `UPDATE credentials SET payload=?, revision=?, updated=?
      WHERE owner=? AND id=? AND revoked IS NULL AND revision=?`,
      )
      .run(
        content,
        randomUUID(),
        Date.now(),
        owner,
        current.id,
        current.revision,
      );
    if (!result.changes)
      throw Error("The subscription changed while reconnecting. Please retry.");
    return current.id;
  });
}

export function getLiteCredential(owner: string, id?: string) {
  return withRegistry(owner, (db) => {
    const row = getActive(db, owner, id);
    return {
      id: row.id,
      revision: row.revision,
      login: validateLiteSubscriptionAuth(row.payload),
    };
  });
}

export function listLiteCredentials(
  owner: string,
  includeRevoked = false,
): ExternalCredentialInfo[] {
  return withRegistry(owner, (db) => {
    const rows = db
      .prepare("SELECT * FROM credentials WHERE owner=? ORDER BY rowid")
      .all(owner) as RecordRow[];
    // Like the hosted registry, revoking the default must not silently select
    // another person's subscription. Keep its designation as a tombstone.
    const defaultId = rows[0]?.id;
    return rows
      .filter((row) => includeRevoked || row.revoked == null)
      .map((row) => {
        const login = codexAuthJsonToAppServerLogin(row.payload);
        return {
          id: row.id,
          provider: "openai",
          kind: "codex-subscription-auth-json",
          scope: "account",
          owner_account_id: owner,
          metadata: {
            label: row.label || undefined,
            provider_account_id:
              login?.type === "chatgptAuthTokens"
                ? login.chatgptAccountId
                : undefined,
            plan_type:
              login?.type === "chatgptAuthTokens"
                ? login.chatgptPlanType
                : undefined,
            cocalc_default: row.id === defaultId,
          },
          created: new Date(row.created),
          updated: new Date(row.updated),
          last_used: row.last_used == null ? null : new Date(row.last_used),
          revoked: row.revoked == null ? null : new Date(row.revoked),
        };
      });
  });
}

export function renameLiteCredential(
  owner: string,
  id: string,
  label = "",
): boolean {
  label = label.trim();
  if (label.length > 60)
    throw Error("Subscription labels must be at most 60 characters.");
  return withRegistry(
    owner,
    (db) =>
      !!db
        .prepare(
          "UPDATE credentials SET label=?, updated=? WHERE owner=? AND id=? AND revoked IS NULL",
        )
        .run(label, Date.now(), owner, id).changes,
  );
}

export function revokeLiteCredential(owner: string, id: string): boolean {
  return withRegistry(
    owner,
    (db) =>
      !!db
        .prepare(
          "UPDATE credentials SET revoked=?, payload='', revision=? WHERE owner=? AND id=? AND revoked IS NULL",
        )
        .run(Date.now(), randomUUID(), owner, id).changes,
  );
}

export function touchLiteCredential(owner: string, id: string): void {
  withRegistry(owner, (db) => {
    const result = db
      .prepare(
        "UPDATE credentials SET last_used=? WHERE owner=? AND id=? AND revoked IS NULL",
      )
      .run(Date.now(), owner, id);
    if (!result.changes)
      throw Error("The selected ChatGPT subscription was revoked.");
  });
}

// A SQLite lease serializes token rotation across Lite's detached workers.
// Revision checks prevent a delayed refresh from undoing reconnect or revoke.
export async function refreshLiteCredential(
  owner: string,
  id: string,
  previousAccessToken: string,
) {
  const lease = randomUUID();
  const deadline = Date.now() + 20_000;
  let current: RecordRow | undefined;
  while (!current) {
    const result = withRegistry(owner, (db) => {
      const row = getActive(db, owner, id);
      if (
        validateLiteSubscriptionAuth(row.payload).accessToken !==
        previousAccessToken
      )
        return { row, changed: true };
      const locked = db
        .prepare(
          `UPDATE credentials SET refresh_lease=?, refresh_until=?
        WHERE owner=? AND id=? AND revision=? AND revoked IS NULL AND
        (refresh_until IS NULL OR refresh_until<?)`,
        )
        .run(lease, Date.now() + 30_000, owner, id, row.revision, Date.now());
      return locked.changes ? { row, changed: false } : undefined;
    });
    if (result?.changed)
      return validateLiteSubscriptionAuth(result.row.payload);
    current = result?.row;
    if (!current) {
      if (Date.now() >= deadline)
        throw Error("ChatGPT sign-in refresh is busy. Retry shortly.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    const parsed = JSON.parse(current.payload);
    if (!parsed.tokens?.refresh_token)
      throw Error("ChatGPT sign-in has expired. Reconnect this subscription.");
    const response = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: parsed.tokens.refresh_token,
      }),
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok)
      throw Error(
        `ChatGPT sign-in refresh failed (HTTP ${response.status}). Reconnect this subscription if retrying does not help.`,
      );
    const tokens = (await response.json()) as Record<string, unknown>;
    if (typeof tokens.access_token !== "string" || !tokens.access_token.trim())
      throw Error("ChatGPT refresh returned no access token.");
    for (const key of ["access_token", "refresh_token", "id_token"]) {
      if (typeof tokens[key] === "string" && tokens[key])
        parsed.tokens[key] = tokens[key];
    }
    parsed.last_refresh = new Date().toISOString();
    const payload = JSON.stringify(parsed);
    validateLiteSubscriptionAuth(payload);
    withRegistry(owner, (db) => {
      db.prepare(
        `UPDATE credentials SET payload=?, revision=?, updated=?
        WHERE owner=? AND id=? AND revision=? AND revoked IS NULL AND refresh_lease=?`,
      ).run(
        payload,
        randomUUID(),
        Date.now(),
        owner,
        id,
        current!.revision,
        lease,
      );
    });
    return getLiteCredential(owner, id).login;
  } finally {
    withRegistry(owner, (db) =>
      db
        .prepare(
          "UPDATE credentials SET refresh_lease=NULL, refresh_until=NULL WHERE id=? AND owner=? AND refresh_lease=?",
        )
        .run(id, owner, lease),
    );
  }
}
