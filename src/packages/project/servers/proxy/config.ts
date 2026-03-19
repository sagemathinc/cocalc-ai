import { userInfo } from "node:os";

export function resolveProxyListenPort(port?: number): number {
  if (port != null) {
    return port;
  }
  if (process.env.COCALC_PROXY_PORT) {
    return parseInt(process.env.COCALC_PROXY_PORT);
  }
  return userInfo().username === "root" ? 80 : 8080;
}
