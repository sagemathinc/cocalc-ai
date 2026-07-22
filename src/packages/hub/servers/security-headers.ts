export function applyBaselineSecurityHeaders(_req, res, next): void {
  // Conservative defaults that improve security without imposing CSP or frame
  // restrictions that could break existing integrations.
  if (!res.hasHeader("X-Content-Type-Options")) {
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  if (!res.hasHeader("X-DNS-Prefetch-Control")) {
    res.setHeader("X-DNS-Prefetch-Control", "off");
  }
  if (!res.hasHeader("X-Permitted-Cross-Domain-Policies")) {
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  }
  if (!res.hasHeader("Referrer-Policy")) {
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  if (!res.hasHeader("Cross-Origin-Opener-Policy")) {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  }
  next();
}
