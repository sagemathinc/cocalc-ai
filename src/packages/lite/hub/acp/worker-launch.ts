import path from "node:path";

export function resolveLiteAcpWorkerLaunch({
  command = process.env.COCALC_LITE_DAEMON_EXEC ?? process.execPath,
  entryPoint = process.env.COCALC_LITE_DAEMON_ENTRYPOINT ?? process.argv[1],
}: {
  command?: string;
  entryPoint?: string;
} = {}): { command: string; args: string[] } {
  const base = path.basename(command).toLowerCase();
  const nodeLike = base === "node" || base.startsWith("node");
  if (nodeLike) {
    const entry = `${entryPoint ?? ""}`.trim();
    if (!entry) {
      throw new Error("unable to resolve lite ACP worker entrypoint");
    }
    return { command, args: [entry] };
  }
  return { command, args: [] };
}
