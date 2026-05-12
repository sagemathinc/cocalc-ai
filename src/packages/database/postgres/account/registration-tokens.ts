import { callback2 } from "@cocalc/util/async-utils";
import { PostgreSQL } from "../types";
import {
  decryptRegistrationTokenValue,
  encryptRegistrationTokenValue,
  hashRegistrationTokenValue,
  isEncryptedRegistrationTokenValue,
  isHashedRegistrationTokenValue,
  storedRegistrationTokenMatches,
} from "./registration-token-secret";

function isDelete(options: { delete?: boolean }[]) {
  return options.some((v) => v?.delete === true);
}

interface Query {
  token: string;
  descr?: string;
  expires?: Date;
  limit?: number;
  disabled?: boolean;
  ephemeral?: boolean;
  customize?;
}

type RegistrationTokenRow = Query & {
  counter?: number;
};

async function runQuery(db: PostgreSQL, query: string, params?: any[]) {
  return await callback2(db._query, { query, params });
}

function isBootstrapCustomize(customize: unknown): boolean {
  return (
    !!customize &&
    typeof customize === "object" &&
    (customize as { bootstrap?: boolean }).bootstrap === true
  );
}

async function findStoredToken(
  db: PostgreSQL,
  token: string,
): Promise<string | undefined> {
  const { rows } = await runQuery(
    db,
    "SELECT token, customize FROM registration_tokens",
  );
  for (const row of rows ?? []) {
    if (isBootstrapCustomize(row.customize)) {
      continue;
    }
    if (await storedRegistrationTokenMatches(row.token, token)) {
      return row.token;
    }
  }
}

async function protectBootstrapTokenAtRest(
  db: PostgreSQL,
  row: RegistrationTokenRow,
): Promise<void> {
  if (isHashedRegistrationTokenValue(row.token)) {
    return;
  }
  const clearToken = await decryptRegistrationTokenValue(row.token);
  await runQuery(db, "UPDATE registration_tokens SET token=$1 WHERE token=$2", [
    await hashRegistrationTokenValue(clearToken),
    row.token,
  ]);
}

async function protectAdminTokenAtRest(
  db: PostgreSQL,
  row: RegistrationTokenRow,
): Promise<string> {
  if (isEncryptedRegistrationTokenValue(row.token)) {
    return await decryptRegistrationTokenValue(row.token);
  }
  const clearToken = await decryptRegistrationTokenValue(row.token);
  await runQuery(db, "UPDATE registration_tokens SET token=$1 WHERE token=$2", [
    await encryptRegistrationTokenValue(clearToken),
    row.token,
  ]);
  return clearToken;
}

export default async function registrationTokensQuery(
  db: PostgreSQL,
  options: { delete?: boolean }[],
  query: Query,
) {
  if (isDelete(options) && query.token) {
    // delete if option is set and there is a token which is defined and not an empty string
    const storedToken = await findStoredToken(db, query.token);
    if (storedToken) {
      await runQuery(db, "DELETE FROM registration_tokens WHERE token = $1", [
        storedToken,
      ]);
    }
    return;
  }

  // either we want to get all tokens or insert/edit one
  if (query.token == "*") {
    // select all tokens -- there is of course no WHERE clause, since this is not user specific.
    // It's the same tokens for any ADMIN.
    const { rows } = await runQuery(db, "SELECT * FROM registration_tokens");
    const visibleRows: RegistrationTokenRow[] = [];
    for (const row of rows ?? []) {
      if (isBootstrapCustomize(row.customize)) {
        await protectBootstrapTokenAtRest(db, row);
        continue;
      }
      if (isHashedRegistrationTokenValue(row.token)) {
        continue;
      }
      const { customize: _customize, ...visibleRow } = row;
      visibleRows.push({
        ...visibleRow,
        token: await protectAdminTokenAtRest(db, row),
      });
    }
    return visibleRows;
  } else if (query.token) {
    // upsert an existing one
    const { token, descr, expires, limit, disabled, ephemeral, customize } =
      query;
    const storedExistingToken = await findStoredToken(db, token);
    const storedToken =
      storedExistingToken != null &&
      isEncryptedRegistrationTokenValue(storedExistingToken)
        ? storedExistingToken
        : await encryptRegistrationTokenValue(token);
    const hasEphemeral = Object.prototype.hasOwnProperty.call(
      query,
      "ephemeral",
    );
    const hasCustomize = Object.prototype.hasOwnProperty.call(
      query,
      "customize",
    );

    if (storedExistingToken != null) {
      const { rows } = await runQuery(
        db,
        `UPDATE registration_tokens
            SET "token"=$1,
                "descr"=$2,
                "expires"=$3,
                "limit"=$4,
                "disabled"=$5,
                "ephemeral"=CASE WHEN $8 THEN $6 ELSE registration_tokens.ephemeral END,
                "customize"=CASE WHEN $9 THEN $7 ELSE registration_tokens.customize END
          WHERE token=$10`,
        [
          storedToken,
          descr ? descr : null,
          expires ? expires : null,
          limit == null ? null : limit,
          disabled != null ? disabled : false,
          ephemeral == null ? null : ephemeral,
          customize == null ? null : customize,
          hasEphemeral,
          hasCustomize,
          storedExistingToken,
        ],
      );
      return rows;
    }

    const { rows } = await runQuery(
      db,
      `INSERT INTO registration_tokens ("token","descr","expires","limit","disabled","ephemeral","customize")
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        storedToken,
        descr ? descr : null,
        expires ? expires : null,
        limit == null ? null : limit, // if undefined make it null
        disabled != null ? disabled : false,
        ephemeral == null ? null : ephemeral,
        customize == null ? null : customize,
      ],
    );
    return rows;
  } else {
    throw new Error("don't know what to do with this query");
  }
}
