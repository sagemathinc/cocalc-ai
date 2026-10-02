/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Who "me" is in personal URLs (/u/<owner>/...): the username if set, else
// the account id. Addresses of my named agents and artifacts use it, so they
// mean the same thing to anyone who opens them.

let identity: { account_id?: string; username?: string | null } = {};

export function setPersonalUrlIdentity(next: {
  account_id?: string;
  username?: string | null;
}): void {
  identity = next;
}

export function personalUrlOwner(): string | undefined {
  return identity.username || identity.account_id || undefined;
}

export function isMyPersonalUrlOwner(owner: string): boolean {
  const o = decodeURIComponent(owner).toLowerCase();
  return (
    !!o &&
    (o === identity.username?.toLowerCase() ||
      o === identity.account_id?.toLowerCase())
  );
}
