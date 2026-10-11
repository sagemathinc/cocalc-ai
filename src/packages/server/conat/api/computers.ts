/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Hub API for the owner's computers; every call runs at the account's home
// bay. Plan: src/.agents/computers-plan-2026-10-11.md.

import type { ComputersApi } from "@cocalc/conat/hub/api/computers";
import { isValidUUID } from "@cocalc/util/misc";
import { computersAtAccountHome } from "@cocalc/server/computers/routing";

function owner(account_id?: string): string {
  if (!isValidUUID(account_id)) throw Error("user must be signed in");
  return account_id!;
}

type In<K extends keyof ComputersApi> = Parameters<ComputersApi[K]>[0];
type Out<K extends keyof ComputersApi> = ReturnType<ComputersApi[K]>;

async function home(account_id?: string) {
  const id = owner(account_id);
  return { id, api: await computersAtAccountHome(id) };
}

export async function listComputers(
  opts: In<"listComputers">,
): Out<"listComputers"> {
  const { id, api } = await home(opts?.account_id);
  return await api.list({ account_id: id });
}

export async function getComputer(opts: In<"getComputer">): Out<"getComputer"> {
  const { id, api } = await home(opts.account_id);
  return await api.get({ account_id: id, computer: opts.computer });
}

export async function listComputerRequests(
  opts: In<"listComputerRequests">,
): Out<"listComputerRequests"> {
  const { id, api } = await home(opts?.account_id);
  return await api.listRequests({ account_id: id });
}

export async function createComputerRequest(
  opts: In<"createComputerRequest">,
): Out<"createComputerRequest"> {
  const { id, api } = await home(opts.account_id);
  const { request_id, expires_at, pairing_url } = await api.createRequest({
    account_id: id,
    name: opts.name,
    requested_policy: opts.policy,
    why: opts.why ?? "",
  });
  return { request_id, expires_at, pairing_url };
}

export async function approveComputerRequest(
  opts: In<"approveComputerRequest">,
): Out<"approveComputerRequest"> {
  const { id, api } = await home(opts.account_id);
  const { computer_id, policy } = await api.approveRequest({
    account_id: id,
    session_hash: opts.session_hash,
    request_id: opts.request_id,
    transcript_hash: opts.transcript_hash,
    agent_network_generation: opts.agent_network_generation,
  });
  return { computer_id, policy };
}

export async function declineComputerRequest(
  opts: In<"declineComputerRequest">,
): Out<"declineComputerRequest"> {
  const { id, api } = await home(opts.account_id);
  await api.declineRequest({ account_id: id, request_id: opts.request_id });
}

export async function revokeComputer(
  opts: In<"revokeComputer">,
): Out<"revokeComputer"> {
  const { id, api } = await home(opts.account_id);
  return await api.revoke({ account_id: id, computer_id: opts.computer_id });
}

export async function extendComputer(
  opts: In<"extendComputer">,
): Out<"extendComputer"> {
  const { id, api } = await home(opts.account_id);
  return await api.extend({
    account_id: id,
    session_hash: opts.session_hash,
    computer_id: opts.computer_id,
    seconds: opts.seconds,
  });
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

export async function setComputerNotes(
  opts: In<"setComputerNotes">,
): Out<"setComputerNotes"> {
  const { id, api } = await home(opts.account_id);
  return await api.setNotes({
    account_id: id,
    computer: opts.computer,
    author: { kind: "owner", account_id: id },
    notes: opts.notes,
    expected_revision: opts.expected_revision,
    locked: opts.locked,
  });
}

export async function setComputerEffectivePolicy(
  opts: In<"setComputerEffectivePolicy">,
): Out<"setComputerEffectivePolicy"> {
  const { id, api } = await home(opts.account_id);
  return await api.setEffectivePolicy({
    account_id: id,
    computer_id: opts.computer_id,
    policy: opts.policy,
  });
}
