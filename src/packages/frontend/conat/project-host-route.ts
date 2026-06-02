export function routeProjectHostHttpUrl({
  url,
  routingAddress,
  windowOrigin,
}: {
  url: string;
  routingAddress?: string;
  windowOrigin?: string;
}): string {
  if (!url || !routingAddress) return url;
  const routingBase = routingAddress.endsWith("/")
    ? routingAddress.slice(0, -1)
    : routingAddress;
  const appendToRoutingBase = (path: string): string => {
    let suffix = path;
    try {
      const routingPath = new URL(
        routingBase,
        windowOrigin ?? "http://localhost",
      ).pathname.replace(/\/+$/, "");
      if (
        routingPath &&
        routingPath !== "/" &&
        (suffix === routingPath || suffix.startsWith(`${routingPath}/`))
      ) {
        suffix = suffix.slice(routingPath.length) || "/";
      }
    } catch {
      // Fall through to the original path when routingBase is not parseable.
    }
    return `${routingBase}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  };
  const isAbsolute = /^https?:\/\//i.test(url);
  if (!isAbsolute) {
    const path = url.startsWith("/") ? url : `/${url}`;
    return appendToRoutingBase(path);
  }
  try {
    const parsed = new URL(url, windowOrigin ?? "http://localhost");
    const parsedUrl = parsed.toString();
    if (
      parsedUrl === routingBase ||
      parsedUrl.startsWith(`${routingBase}/`) ||
      parsedUrl.startsWith(`${routingBase}?`) ||
      parsedUrl.startsWith(`${routingBase}#`)
    ) {
      return parsedUrl;
    }
    const shouldRoute =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      (!!windowOrigin && parsed.origin === windowOrigin);
    if (!shouldRoute) {
      return parsedUrl;
    }
    return appendToRoutingBase(
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
    );
  } catch {
    return url;
  }
}
