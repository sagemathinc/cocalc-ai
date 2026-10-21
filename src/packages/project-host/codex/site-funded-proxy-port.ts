/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

// Projects reach the site-funded Codex proxy through pasta as a host-local
// port, and the project egress block (cocalc-runtime-storage,
// emit_project_metadata_rules in bootstrap.py) drops new project connections
// to host-local ports except DNS, the conat router and this range. Each ACP
// worker binds the first free port: a draining worker keeps its port while
// the new one takes the next. Keep the derivation and the range size in sync
// with project_site_codex_proxy_ports in bootstrap.py.
//
// The daemon pins COCALC_PROJECT_HOST_SITE_CODEX_PROXY_PORT in ensureDefaults
// from the PORT of its env files, because the project-host child (and so the
// ACP worker) runs with PORT rewritten to the app port. This module has no
// dependencies so the daemon can import it.

export const SITE_FUNDED_CODEX_PROXY_PORT_COUNT = 16;
const SITE_FUNDED_CODEX_PROXY_PORT_OFFSET = 300;
const DEFAULT_PROJECT_HOST_PORT = 9002;

// Number(value) when it is a valid TCP port of at least min, as the bootstrap
// helper reads it.
function tcpPort(value: string | undefined, min = 1): number | undefined {
  if (!value?.trim()) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= min && port <= 65535
    ? port
    : undefined;
}

export function siteFundedCodexProxyPorts(
  env: Record<string, string | undefined> = process.env,
): number[] {
  // The runtime user cannot bind privileged ports, so an explicit start below
  // 1024 falls back like an invalid one.
  let first = tcpPort(env.COCALC_PROJECT_HOST_SITE_CODEX_PROXY_PORT, 1024);
  if (first == null) {
    // PORT as daemon.ts parsePort reads it: the text after the last ":".
    first =
      (tcpPort(env.PORT?.slice(env.PORT.lastIndexOf(":") + 1)) ??
        DEFAULT_PROJECT_HOST_PORT) + SITE_FUNDED_CODEX_PROXY_PORT_OFFSET;
    if (first > 65535) {
      first = DEFAULT_PROJECT_HOST_PORT + SITE_FUNDED_CODEX_PROXY_PORT_OFFSET;
    }
  }
  const ports: number[] = [];
  for (
    let port = first;
    port <= 65535 && ports.length < SITE_FUNDED_CODEX_PROXY_PORT_COUNT;
    port++
  ) {
    ports.push(port);
  }
  return ports;
}
