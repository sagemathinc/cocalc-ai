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
}: {
  req: IncomingMessage;
  sessionToken: string;
  project_id: string;
}): string {
  const attrs = [
    `${PROJECT_HOST_HTTP_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    `Path=${projectCookiePath(project_id)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${HTTP_SESSION_TTL_SECONDS}`,
  ];
  if (isSecureRequest(req)) {
    attrs.push("Secure");
  }
  return attrs.join("; ");
}
