/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Application } from "express";
import TTL from "@isaacs/ttlcache";
import { assertSecureUrlOrLocal } from "@cocalc/backend/network/policy";
import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import type { Client } from "@cocalc/conat/core/client";
import {
  API_RELAY_PATH,
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
  type ProjectApiRelayTarget,
  normalizeApiRelayHubUrl,
} from "@cocalc/conat/project-host/api-relay";
import {
  createApiRelay,
  type ApiRelayAdmission,
} from "@cocalc/project-proxy/api-relay";
import { isValidUUID } from "@cocalc/util/misc";
import { getProject } from "./sqlite/projects";

const logger = getLogger("project-host:api-relay");

function forbidden(): never {
  throw Object.assign(new Error("project API relay authentication required"), {
    statusCode: 403,
  });
}

export function authenticateApiRelay(req: IncomingMessage): ApiRelayAdmission {
  const address = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? ""))
    forbidden();
  // This is a container-to-host service, not an ingress endpoint for browsers.
  if (
    Object.keys(req.headers).some(
      (name) =>
        name === "forwarded" ||
        name.startsWith("x-forwarded-") ||
        name.startsWith("cf-"),
    )
  )
    forbidden();
  const projectId = req.headers[API_RELAY_PROJECT_HEADER];
  const secret = req.headers[API_RELAY_SECRET_HEADER];
  if (
    typeof projectId !== "string" ||
    !isValidUUID(projectId) ||
    typeof secret !== "string" ||
    !secret ||
    secret.length > 4096
  )
    forbidden();
  const stillAuthorized = () => {
    const project = getProject(projectId);
    if (
      !project ||
      project.exam_run_id ||
      !["running", "starting"].includes(project.state ?? "")
    )
      return false;
    const expected = Buffer.from(project.secret_token ?? "");
    const supplied = Buffer.from(secret);
    return (
      expected.length > 0 &&
      expected.length === supplied.length &&
      timingSafeEqual(expected, supplied)
    );
  };
  if (!stillAuthorized()) forbidden();
  return { projectId, stillAuthorized };
}

export async function resolveApiRelayHubUrl(
  requestedUrl: string | undefined,
  {
    siteUrl,
    hostId,
    masterClient,
  }: {
    siteUrl?: string;
    hostId: string;
    masterClient?: Client;
  },
): Promise<string> {
  if (!siteUrl) throw Error("API relay site URL is not configured");
  const site = normalizeApiRelayHubUrl(siteUrl);
  const requested = normalizeApiRelayHubUrl(requestedUrl ?? site);
  if (requested !== site) {
    if (!masterClient) throw Error("master Conat connection is unavailable");
    const target = await callHub({
      client: masterClient,
      host_id: hostId,
      name: "hosts.resolveProjectApiRelayHub",
      args: [{ url: requested }],
      timeout: 10_000,
    });
    if (target?.url !== requested)
      throw Error("API relay hub routing identity mismatch");
  }
  assertSecureUrlOrLocal({ url: requested, urlName: "API relay hub" });
  return requested;
}

export function attachProjectApiRelay({
  app,
  httpServer,
  hostId,
  masterClient,
}: {
  app: Application;
  httpServer: Server;
  hostId: string;
  masterClient?: Client;
}): () => void {
  const routes = new TTL<string, string>({ max: 1024, ttl: 30_000 });
  const relay = createApiRelay({
    authenticate: authenticateApiRelay,
    hubUrl: async (requestedUrl) => {
      const key = `hub:${requestedUrl ?? "site"}`;
      const cached = routes.get(key);
      if (cached) return cached;
      // The host's master may be a different bay from the caller's home bay.
      const url = await resolveApiRelayHubUrl(requestedUrl, {
        siteUrl: process.env.COCALC_SITE_URL,
        hostId,
        masterClient,
      });
      routes.set(key, url);
      return url;
    },
    hostUrl: async (host_id, project_id) => {
      const key = `${host_id}:${project_id}`;
      const cached = routes.get(key);
      if (cached) return cached;
      const client = masterClient;
      if (!client) throw Error("master Conat connection is unavailable");
      const target = (await callHub({
        client,
        host_id: hostId,
        name: "hosts.resolveProjectApiRelayTarget",
        args: [{ target_host_id: host_id, target_project_id: project_id }],
        timeout: 10_000,
      })) as ProjectApiRelayTarget;
      if (target.host_id !== host_id || target.project_id !== project_id)
        throw Error("API relay routing identity mismatch");
      assertSecureUrlOrLocal({
        url: target.url,
        urlName: "API relay project host",
      });
      routes.set(key, target.url);
      return target.url;
    },
    onError: (error) =>
      logger.debug("API relay request failed", { code: (error as any).code }),
  });
  app.use((req, res, next) => {
    if (!req.url.startsWith(`${API_RELAY_PATH}/`)) return next();
    void relay.handleRequest(req, res);
  });
  const upgrade = (req, socket, head) => {
    if (req.url?.startsWith(`${API_RELAY_PATH}/`)) {
      void relay.handleUpgrade(req, socket, head);
    } else if (!/^\/conat\/?(?:\?|$)/.test(req.url ?? "")) {
      socket.destroy();
    }
  };
  httpServer.on("upgrade", upgrade);
  return () => {
    httpServer.off("upgrade", upgrade);
    relay.close();
    routes.clear();
  };
}
