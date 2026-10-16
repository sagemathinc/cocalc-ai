/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Hub API for the owner's computers; every call runs at the account's home
// bay. Design: src/.agents/computers-direct-host-2026-10-16.md.

import type { ComputersApi } from "@cocalc/conat/hub/api/computers";
import { isValidUUID } from "@cocalc/util/misc";
import { computersAtAccountHome } from "@cocalc/server/computers/routing";
import { assertComputersEnabled } from "@cocalc/server/computers/enabled";

function owner(account_id?: string): string {
  if (!isValidUUID(account_id)) throw Error("user must be signed in");
  return account_id!;
}

type In<K extends keyof ComputersApi> = Parameters<ComputersApi[K]>[0];
type Out<K extends keyof ComputersApi> = ReturnType<ComputersApi[K]>;

// `cleanup`: listing, declining and revoking stay available while the site's
// computers switch is off; everything else needs it on.
async function home(account_id?: string, { cleanup = false } = {}) {
  const id = owner(account_id);
  if (!cleanup) await assertComputersEnabled();
  return { id, api: await computersAtAccountHome(id) };
}

export async function listComputers(
  opts: In<"listComputers">,
): Out<"listComputers"> {
  const { id, api } = await home(opts?.account_id, { cleanup: true });
  return await api.list({ account_id: id });
}

export async function listComputerRequests(
  opts: In<"listComputerRequests">,
): Out<"listComputerRequests"> {
  const { id, api } = await home(opts?.account_id, { cleanup: true });
  return await api.listRequests({ account_id: id });
}

export async function createComputerRequest(
  opts: In<"createComputerRequest">,
): Out<"createComputerRequest"> {
  const { id, api } = await home(opts.account_id);
  return await api.createRequest({
    account_id: id,
    name: opts.name,
    project_id: opts.project_id,
  });
}

export async function approveComputerRequest(
  opts: In<"approveComputerRequest">,
): Out<"approveComputerRequest"> {
  const { id, api } = await home(opts.account_id);
  return await api.approveRequest({
    account_id: id,
    session_hash: opts.session_hash,
    request_id: opts.request_id,
    pairing_phrase: opts.pairing_phrase,
  });
}

export async function declineComputerRequest(
  opts: In<"declineComputerRequest">,
): Out<"declineComputerRequest"> {
  const { id, api } = await home(opts.account_id, { cleanup: true });
  await api.declineRequest({ account_id: id, request_id: opts.request_id });
}

export async function revokeComputer(
  opts: In<"revokeComputer">,
): Out<"revokeComputer"> {
  const { id, api } = await home(opts.account_id, { cleanup: true });
  await api.revoke({ account_id: id, computer_id: opts.computer_id });
}

export async function renameComputer(
  opts: In<"renameComputer">,
): Out<"renameComputer"> {
  const { id, api } = await home(opts.account_id);
  await api.rename({
    account_id: id,
    computer_id: opts.computer_id,
    name: opts.name,
  });
}
