import getClient from "./client";
import getPool from "@cocalc/database/pool";

// https://developers.salesloft.com/docs/api/people-index
export async function list(params: object) {
  const client = await getClient();
  const { data } = await client.get("people", { params });
  return data;
}

export async function create(newPerson: object) {
  const client = await getClient();
  const { data } = await client.post("people", newPerson);
  return data;
}

export async function destroy(personId: string) {
  const db = getPool();
  // this would likely be slow, due to no index.
  await db.query(
    "UPDATE accounts SET salesloft_id=NULL WHERE salesloft_id=$1",
    [personId],
  );
  const client = await getClient();
  await client.delete(`/people/${personId}`);
}

// Delete the Salesloft person of a deleted cocalc account. The remote person is
// deleted first (a person that is already gone counts as deleted), and only
// then is the local link cleared, so a failure leaves the link for a retry
// instead of an orphaned Salesloft record.
export async function destroyForDeletedAccount(
  account_id: string,
  personId: string,
): Promise<void> {
  const client = await getClient();
  try {
    await client.delete(`/people/${personId}`);
  } catch (err) {
    if ((err as any)?.response?.status !== 404) {
      throw err;
    }
  }
  await getPool().query(
    "UPDATE accounts SET salesloft_id=NULL WHERE account_id=$1 AND salesloft_id=$2",
    [account_id, personId],
  );
}

export async function fetch(personId: string) {
  const client = await getClient();
  const { data } = await client.get(`/people/${personId}`);
  return data;
}

export async function update(personId: string, changes: object) {
  const client = await getClient();
  const { data } = await client.put(`/people/${personId}`, changes);
  return data;
}
