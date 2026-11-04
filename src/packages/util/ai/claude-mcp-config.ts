/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The MCP servers a Claude agent may use, from Claude Code's own config in
// the project (what `claude mcp add` writes), so the same command works for
// the web UI as for the CLI. In CoCalc, ~/.claude.json is shared project-home
// state: every collaborator's Claude agents in the project use its servers,
// and anyone who can edit project files can change it.
//
// Scopes (Claude Code's; a name in a narrower scope wins):
// - local:   ~/.claude.json projects[<cwd>].mcpServers (`claude mcp add`)
// - project: <cwd>/.mcp.json mcpServers, used only when approved in the
//            user's own files (~/.claude.json projects[<cwd>] or
//            ~/.claude/settings.json), never by settings in <cwd> itself:
//            a folder that arrived with a clone must not approve itself
// - user:    ~/.claude.json mcpServers (`claude mcp add --scope user`)
//
// Each server is bound to a digest of its scope and definition, so the
// process started later is exactly the one listed here.

import { sha256Utf8 } from "../sha256-utf8";

export type ClaudeMcpScope = "local" | "project" | "user";

export interface ClaudeMcpStdioServer {
  name: string;
  scope: ClaudeMcpScope;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** SHA-256 of the canonical scope and definition. */
  digest: string;
}

export interface ClaudeMcpSkipped {
  name: string;
  scope: ClaudeMcpScope;
  reason: string;
}

export interface ClaudeMcpConfig {
  servers: ClaudeMcpStdioServer[];
  skipped: ClaudeMcpSkipped[];
}

export const MAX_CLAUDE_MCP_SERVERS = 8;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 4096;
const MAX_ARGS = 64;
const MAX_ENV = 64;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Names CoCalc's own tool server uses; a user server may not take them. */
export function reservedClaudeMcpName(name: string): boolean {
  return /^cocalc/i.test(name);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TEXT &&
    !value.includes("\0")
  );
}

/** The canonical form a digest covers (keys in a fixed order). */
function canonical(server: Omit<ClaudeMcpStdioServer, "digest">): string {
  const env = Object.keys(server.env)
    .sort()
    .map((key) => [key, server.env[key]]);
  return JSON.stringify([
    "stdio",
    server.scope,
    server.name,
    server.command,
    server.args,
    env,
  ]);
}

export function claudeMcpDigest(
  server: Omit<ClaudeMcpStdioServer, "digest">,
): string {
  return sha256Utf8(canonical(server))!.sha256;
}

/** One entry, validated; a reason when it can't be used. */
function parseServer(
  name: string,
  scope: ClaudeMcpScope,
  value: unknown,
): ClaudeMcpStdioServer | { reason: string } {
  if (!NAME.test(name)) return { reason: "invalid name" };
  if (reservedClaudeMcpName(name))
    return { reason: "names starting with cocalc are reserved" };
  const entry = object(value);
  if (!entry) return { reason: "not an object" };
  const type = entry.type ?? "stdio";
  if (type === "http" || type === "sse" || entry.url != null)
    return { reason: "remote (http/sse) servers are not supported yet" };
  if (type !== "stdio") return { reason: `unknown type ${String(type)}` };
  if (!text(entry.command)) return { reason: "missing or invalid command" };
  const args = entry.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > MAX_ARGS ||
    !args.every((arg) => typeof arg === "string" && arg.length <= MAX_TEXT)
  )
    return { reason: "invalid args" };
  const envIn = entry.env ?? {};
  const envObject = object(envIn);
  if (!envObject) return { reason: "invalid env" };
  const keys = Object.keys(envObject);
  if (
    keys.length > MAX_ENV ||
    !keys.every(
      (key) =>
        ENV_NAME.test(key) &&
        typeof envObject[key] === "string" &&
        (envObject[key] as string).length <= MAX_TEXT,
    )
  )
    return { reason: "invalid env" };
  const server = {
    name,
    scope,
    command: entry.command,
    args: args as string[],
    env: Object.fromEntries(keys.map((key) => [key, envObject[key] as string])),
  };
  return { ...server, digest: claudeMcpDigest(server) };
}

function names(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((x): x is string => typeof x === "string")
      : [],
  );
}

/**
 * The servers a Claude agent working in `cwd` may use, from the project's
 * ~/.claude.json, ~/.claude/settings.json and <cwd>/.mcp.json (parsed JSON,
 * or undefined when missing or unreadable).
 */
export function claudeMcpServers({
  claudeJson,
  userSettings,
  mcpJson,
  cwd,
}: {
  claudeJson?: unknown;
  userSettings?: unknown;
  mcpJson?: unknown;
  cwd: string;
}): ClaudeMcpConfig {
  const home = object(claudeJson) ?? {};
  const local = object(object(home.projects)?.[cwd]) ?? {};
  const settings = object(userSettings) ?? {};
  // Approval of .mcp.json servers, only from the user's own files.
  const approveAll =
    local.enableAllProjectMcpServers === true ||
    settings.enableAllProjectMcpServers === true;
  const approved = new Set([
    ...names(local.enabledMcpjsonServers),
    ...names(settings.enabledMcpjsonServers),
  ]);
  const disabled = new Set([
    ...names(local.disabledMcpjsonServers),
    ...names(settings.disabledMcpjsonServers),
  ]);

  const servers = new Map<string, ClaudeMcpStdioServer>();
  const skipped: ClaudeMcpSkipped[] = [];
  const add = (
    scope: ClaudeMcpScope,
    entries: unknown,
    allow: (name: string) => string | undefined = () => undefined,
  ) => {
    const map = object(entries);
    if (!map) return;
    for (const [name, value] of Object.entries(map).slice(0, 64)) {
      // A narrower scope already named it.
      if (servers.has(name)) continue;
      const refused = allow(name);
      if (refused) {
        skipped.push({ name, scope, reason: refused });
        continue;
      }
      const parsed = parseServer(name, scope, value);
      if ("reason" in parsed)
        skipped.push({ name, scope, reason: parsed.reason });
      else servers.set(name, parsed);
    }
  };
  add("local", local.mcpServers);
  add("project", object(mcpJson)?.mcpServers, (name) =>
    disabled.has(name)
      ? "disabled for this directory"
      : approveAll || approved.has(name)
        ? undefined
        : "in .mcp.json but not approved (approve it once in the Claude CLI, or set enableAllProjectMcpServers)",
  );
  add("user", home.mcpServers);

  const list = [...servers.values()];
  for (const server of list.slice(MAX_CLAUDE_MCP_SERVERS))
    skipped.push({
      name: server.name,
      scope: server.scope,
      reason: `more than ${MAX_CLAUDE_MCP_SERVERS} servers`,
    });
  return { servers: list.slice(0, MAX_CLAUDE_MCP_SERVERS), skipped };
}

/**
 * ${VAR} and ${VAR:-default} in a definition, from the environment the
 * server starts in (as Claude Code expands .mcp.json). Unknown variables
 * without a default stay empty.
 */
export function expandClaudeMcpVariables(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => env[name] ?? fallback ?? "",
  );
}
