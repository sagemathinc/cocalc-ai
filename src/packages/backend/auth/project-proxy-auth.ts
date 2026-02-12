export const PROJECT_PROXY_AUTH_HEADER = "x-cocalc-project-secret";

export function getSingleHeaderValue(
  header: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(header)) {
    return header.length > 0 ? `${header[0]}` : undefined;
  }
  if (typeof header === "string") {
    return header;
  }
  return undefined;
}
