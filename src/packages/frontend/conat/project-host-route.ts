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
  const isAbsolute = /^https?:\/\//i.test(url);
  if (!isAbsolute) {
    const path = url.startsWith("/") ? url : `/${url}`;
    return `${routingBase}${path}`;
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
    return `${routingBase}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
