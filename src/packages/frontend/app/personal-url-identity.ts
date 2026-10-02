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

// My project aliases (project_id <-> alias). A project with an alias has the
// address /u/<me>/projects/<alias>/... instead of /projects/<id>/...
let projectAliases = new Map<string, string>();
let projectsByAlias = new Map<string, string>();
const aliasListeners = new Set<() => void>();

export function setMyProjectAliases(
  rows: { project_id: string; alias: string }[],
): void {
  projectAliases = new Map(rows.map((r) => [r.project_id, r.alias]));
  projectsByAlias = new Map(rows.map((r) => [r.alias, r.project_id]));
  for (const listener of aliasListeners) listener();
}

export function myProjectAlias(project_id: string): string | undefined {
  return projectAliases.get(project_id);
}

export function myProjectForAlias(alias: string): string | undefined {
  return projectsByAlias.get(decodeURIComponent(alias).toLowerCase());
}

export function myProjectAliases(): ReadonlyMap<string, string> {
  return projectAliases;
}

export function onMyProjectAliasesChange(listener: () => void): () => void {
  aliasListeners.add(listener);
  return () => {
    aliasListeners.delete(listener);
  };
}
