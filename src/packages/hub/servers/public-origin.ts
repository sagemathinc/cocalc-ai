import type { Request } from "express";

function firstHeaderValue(value?: string): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function requestProtocol(req: Request): "http" | "https" {
  const proto = firstHeaderValue(req.get("x-forwarded-proto")) ?? req.protocol;
  return proto === "http" ? "http" : "https";
}

export function publicOrigin(req: Request): string {
  const host =
    firstHeaderValue(req.get("x-forwarded-host")) ??
    firstHeaderValue(req.get("host")) ??
    "cocalc.com";
  return `${requestProtocol(req)}://${host}`;
}
