import {
  safeSshDestination,
  sshDestinationArgs,
} from "@cocalc/backend/ssh-destination";

// The host comes from stored host metadata: only a checked user and address.
export function scanHostSshArgs({
  sshUser,
  host,
}: {
  sshUser: string;
  host: string;
}): string[] {
  const target = safeSshDestination(sshUser, host, { requireIp: true });
  if (target == null) {
    throw new Error("scan host ssh user or address is not allowed");
  }
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    ...sshDestinationArgs(target, ["python3", "-"]),
  ];
}
