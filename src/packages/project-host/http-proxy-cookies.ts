import type { IncomingMessage } from "node:http";
import { PROJECT_HOST_HTTP_SESSION_COOKIE_NAME } from "@cocalc/conat/auth/project-host-http";

const HTTP_SESSION_TTL_SECONDS = Math.max(
  300,
  Number.isFinite(
    Number(process.env.COCALC_PROJECT_HOST_HTTP_SESSION_TTL_SECONDS),
  )
    ? Number(process.env.COCALC_PROJECT_HOST_HTTP_SESSION_TTL_SECONDS)
    : 30 * 24 * 60 * 60,
);

export function projectCookiePath(project_id: string): string {
  return `/${project_id}`;
}

export function legacyProjectHostCookiePath(): string {
  return "/";
}

export function isSecureRequest(req: IncomingMessage): boolean {
  const xfProto = `${req.headers["x-forwarded-proto"] ?? ""}`.toLowerCase();
  if (xfProto.includes("https")) return true;
  // @ts-ignore node IncomingMessage.socket may have encrypted in tls mode.
  return !!req.socket?.encrypted;
}

export function buildProjectHostSessionCookie({
  req,
  sessionToken,
  project_id,
  max_age_seconds = HTTP_SESSION_TTL_SECONDS,
}: {
  req: IncomingMessage;
  sessionToken: string;
  project_id: string;
  max_age_seconds?: number;
}): string {
  const maxAge = Math.max(
    1,
    Math.min(HTTP_SESSION_TTL_SECONDS, Math.floor(max_age_seconds)),
  );
  const attrs = [
    `${PROJECT_HOST_HTTP_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    `Path=${projectCookiePath(project_id)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(req)) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}

export function buildProjectHostSessionCookieDeletion({
  req,
  path,
}: {
  req: IncomingMessage;
  path: string;
}): string {
  const attrs = [
    `${PROJECT_HOST_HTTP_SESSION_COOKIE_NAME}=`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isSecureRequest(req)) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}
