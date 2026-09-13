import { validateMessageHeaders } from "../core/message-headers";

// Set by the authenticated router, never taken from a file request's body.
export const FILE_READ_PRINCIPAL_HEADER = "CN-File-Read-Principal";

export function fileReadPrincipal(
  user:
    | {
        account_id?: string;
        project_id?: string;
      }
    | undefined,
): string | undefined {
  if (user?.account_id) return `account:${user.account_id}`;
  if (user?.project_id) return `project:${user.project_id}`;
}

export function stampFileReadPrincipal({
  subject,
  data,
  user,
  trusted,
}: {
  subject: string;
  data: any[];
  user: any;
  trusted: boolean;
}): void {
  if (!/^project\.[^.]+\.files:read[^.]*\./.test(subject) || !data[2]) return;
  validateMessageHeaders(data[5]);
  const headers = data[5] ?? (data[5] = Object.create(null));
  const supplied = headers[FILE_READ_PRINCIPAL_HEADER];
  // Host HTTP handlers may forward an identity they have authenticated. Cluster
  // links preserve the originating router's stamp. Ordinary sockets cannot.
  const principal =
    trusted &&
    typeof supplied === "string" &&
    (supplied === "unattributed" ||
      /^(account|project):[a-zA-Z0-9-]{1,128}$/.test(supplied))
      ? supplied
      : (fileReadPrincipal(user) ??
        (trusted ? `project:${subject.split(".")[1]}` : "unattributed"));
  headers[FILE_READ_PRINCIPAL_HEADER] = principal;
  // The outgoing stamp counts toward the same bounds on every cluster hop.
  validateMessageHeaders(headers);
}
