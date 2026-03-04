/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ProxyType =
  | "port"
  | "raw"
  | "server"
  | "files"
  | "proxy"
  | "conat"
  | "apps";
export type ProxyAccessType = "read" | "write";

export interface ProxyRouteDefinition {
  type: ProxyType;
  requiresPortDesc: boolean;
  allowsInternalUrl: boolean;
  access: ProxyAccessType;
}

const ROUTES: Record<ProxyType, ProxyRouteDefinition> = {
  // Generic HTTP port proxy for project services.
  port: {
    type: "port",
    requiresPortDesc: true,
    allowsInternalUrl: false,
    access: "write",
  },
  // Legacy raw browser server path.
  raw: {
    type: "raw",
    requiresPortDesc: false,
    allowsInternalUrl: false,
    access: "write",
  },
  // Server/proxy variants carry an additional internal url suffix.
  server: {
    type: "server",
    requiresPortDesc: true,
    allowsInternalUrl: true,
    access: "write",
  },
  proxy: {
    type: "proxy",
    requiresPortDesc: true,
    allowsInternalUrl: true,
    access: "write",
  },
  // File downloads allow read-only project access.
  files: {
    type: "files",
    requiresPortDesc: false,
    allowsInternalUrl: false,
    access: "read",
  },
  // Conat pass-through path to project-host conat service.
  conat: {
    type: "conat",
    requiresPortDesc: false,
    allowsInternalUrl: false,
    access: "write",
  },
  // App-server paths are proxied through project-host to the in-project app proxy.
  apps: {
    type: "apps",
    requiresPortDesc: false,
    allowsInternalUrl: false,
    access: "write",
  },
};

export const PROXY_TYPE_SEGMENTS = new Set<string>(Object.keys(ROUTES));

export function getProxyRouteDefinition(type: string): ProxyRouteDefinition | undefined {
  if (!PROXY_TYPE_SEGMENTS.has(type)) {
    return;
  }
  return ROUTES[type as ProxyType];
}
