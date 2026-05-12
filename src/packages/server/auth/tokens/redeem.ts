/* Redeem a registration token.

Raise an exception on failure with the error explaining the exception.

If no token is needed because of how site is configured,
then returns no matter what the input is.
*/

import { createInterBayAuthTokenClient } from "@cocalc/conat/inter-bay/api";
import getRequiresTokens from "./get-requires-token";
import { getRequiresTokensDirect } from "./get-requires-token";
import getPool, { getTransactionClient } from "@cocalc/database/pool";
import {
  getConfiguredClusterRole,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  encryptRegistrationTokenValue,
  hashRegistrationTokenValue,
  isEncryptedRegistrationTokenValue,
  isHashedRegistrationTokenValue,
  storedRegistrationTokenMatches,
} from "@cocalc/database/postgres/account/registration-token-secret";

export interface RegistrationTokenInfo {
  token: string;
  ephemeral?: number;
  customize?: any;
}

interface RegistrationTokenRow {
  token: string;
  expires?: Date | null;
  counter?: number | null;
  limit?: number | null;
  disabled?: boolean | null;
  ephemeral?: number | null;
  customize?: any;
}

interface MatchedRegistrationToken {
  storedToken: string;
  row: RegistrationTokenRow;
}

function isBootstrapCustomize(customize: unknown): boolean {
  return (
    !!customize &&
    typeof customize === "object" &&
    (customize as { bootstrap?: boolean }).bootstrap === true
  );
}

async function findRegistrationToken(
  client: {
    query: (query: string, params?: any[]) => Promise<{ rows: any[] }>;
  },
  token: string,
  opts: { forUpdate?: boolean } = {},
): Promise<MatchedRegistrationToken | undefined> {
  const { rows } = await client.query(
    `SELECT "token", "expires", "counter", "limit", "disabled", "ephemeral", "customize"
       FROM registration_tokens${opts.forUpdate ? " FOR UPDATE" : ""}`,
  );
  for (const row of rows ?? []) {
    if (await storedRegistrationTokenMatches(row.token, token)) {
      return { storedToken: row.token, row };
    }
  }
}

async function protectedStorageValueForMatchedToken(
  clearToken: string,
  match: MatchedRegistrationToken,
): Promise<string> {
  if (isBootstrapCustomize(match.row.customize)) {
    return await hashRegistrationTokenValue(clearToken);
  }
  if (
    isEncryptedRegistrationTokenValue(match.storedToken) ||
    isHashedRegistrationTokenValue(match.storedToken)
  ) {
    return match.storedToken;
  }
  return await encryptRegistrationTokenValue(clearToken);
}

async function protectMatchedRegistrationTokenAtRest(
  client: {
    query: (query: string, params?: any[]) => Promise<{ rows: any[] }>;
  },
  clearToken: string,
  match: MatchedRegistrationToken,
): Promise<string> {
  const protectedToken = await protectedStorageValueForMatchedToken(
    clearToken,
    match,
  );
  if (protectedToken !== match.storedToken) {
    await client.query(
      "UPDATE registration_tokens SET token=$1 WHERE token=$2",
      [protectedToken, match.storedToken],
    );
  }
  return protectedToken;
}

function registrationTokenInfoFromRow(
  token: string,
  row: {
    expires?: Date | null;
    counter?: number | null;
    limit?: number | null;
    disabled?: boolean | null;
    ephemeral?: number | null;
    customize?: any;
  },
): RegistrationTokenInfo {
  const counter = row.counter ?? 0;
  const disabled = row.disabled ?? false;

  if (disabled) {
    throw Error("Registration token disabled.");
  }

  if (row.expires != null && row.expires.getTime() < new Date().getTime()) {
    throw Error("Registration token no longer valid.");
  }

  if (row.limit != null && row.limit <= counter) {
    throw Error("Registration token used up.");
  }

  return {
    token,
    ephemeral: typeof row.ephemeral === "number" ? row.ephemeral : undefined,
    customize: row.customize,
  };
}

export async function validateRegistrationTokenDirect(
  token: string,
): Promise<RegistrationTokenInfo | undefined> {
  const required = await getRequiresTokensDirect();
  if (!required) {
    return;
  }

  if (!token) {
    throw Error("no registration token provided");
  }

  const pool = getPool();
  const match = await findRegistrationToken(pool, token);
  if (match == null) {
    throw Error("Registration token is wrong.");
  }
  await protectMatchedRegistrationTokenAtRest(pool, token, match);
  return registrationTokenInfoFromRow(token, match.row);
}

export async function redeemRegistrationTokenDirect(
  token: string,
): Promise<RegistrationTokenInfo | undefined> {
  const required = await getRequiresTokensDirect();
  if (!required) {
    // no token required, so nothing to do.
    return;
  }

  if (!token) {
    throw Error("no registration token provided");
  }

  const client = await getTransactionClient();

  try {
    // overview: first, we check if the token matches.
    // → check if it is disabled?
    // → check expiration date → abort if expired
    // → if counter, check counter vs. limit
    //   → true: increase the counter → ok
    //   → false: ok
    const match = await findRegistrationToken(client, token, {
      forUpdate: true,
    });

    if (match == null) {
      throw Error("Registration token is wrong.");
    }
    // e.g. { expires: 2020-12-04T11:54:52.889Z, counter: null, limit: 10, disabled: ... }
    const info = registrationTokenInfoFromRow(token, match.row);
    const protectedStoredToken = await protectedStorageValueForMatchedToken(
      token,
      match,
    );

    // we count in any case after validation succeeds.
    await client.query(
      `UPDATE registration_tokens
          SET "token"=$1,
              "counter"=coalesce("counter", 0) + 1
        WHERE token=$2`,
      [protectedStoredToken, match.storedToken],
    );

    // all good, let's commit
    await client.query("COMMIT");
    return info;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function disableRegistrationTokenDirect(
  token: string,
): Promise<void> {
  if (!token) {
    return;
  }
  await getTransactionClient().then(async (client) => {
    try {
      const match = await findRegistrationToken(client, token, {
        forUpdate: true,
      });
      if (match == null) {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        "UPDATE registration_tokens SET token=$1, disabled=true WHERE token=$2",
        [
          await protectedStorageValueForMatchedToken(token, match),
          match.storedToken,
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function deleteRegistrationTokenDirect(
  token: string,
): Promise<void> {
  if (!token) {
    return;
  }
  await getTransactionClient().then(async (client) => {
    try {
      const match = await findRegistrationToken(client, token, {
        forUpdate: true,
      });
      if (match != null) {
        await client.query("DELETE FROM registration_tokens WHERE token=$1", [
          match.storedToken,
        ]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function disableRegistrationToken(token: string): Promise<void> {
  if (!token) {
    return;
  }
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    await disableRegistrationTokenDirect(token);
    return;
  }
  await createInterBayAuthTokenClient({
    client: getInterBayFabricClient(),
  }).disable({ token });
}

export async function deleteRegistrationToken(token: string): Promise<void> {
  if (!token) {
    return;
  }
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    await deleteRegistrationTokenDirect(token);
    return;
  }
  await createInterBayAuthTokenClient({
    client: getInterBayFabricClient(),
  }).delete({ token });
}

export default async function redeem(
  token: string,
): Promise<RegistrationTokenInfo | undefined> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await redeemRegistrationTokenDirect(token);
  }
  const required = await getRequiresTokens();
  if (!required) {
    return;
  }
  const result = await createInterBayAuthTokenClient({
    client: getInterBayFabricClient(),
  }).redeem({ token });
  return result ?? undefined;
}

export async function validateRegistrationToken(
  token: string,
): Promise<RegistrationTokenInfo | undefined> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await validateRegistrationTokenDirect(token);
  }
  const required = await getRequiresTokens();
  if (!required) {
    return;
  }
  const result = await createInterBayAuthTokenClient({
    client: getInterBayFabricClient(),
  }).validate({ token });
  return result ?? undefined;
}
