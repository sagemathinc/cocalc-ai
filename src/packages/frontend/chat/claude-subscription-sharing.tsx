/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
When a Claude agent paid by the user's own Claude subscription runs in the
project (the site's "project" Claude subscription runtime), another process
in that project could deliberately use the session while it runs. CoCalc
cannot protect against a collaborator who sets out to do that, so the user is
told briefly before the first turn in a project with other collaborators, and
again whenever the collaborators change, with a link to the docs page that
explains it in full. If the collaborators cannot be read, the warning is
shown. Like the backend (project-host's claudeSubscriptionRuntime), only the
"project" runtime counts: any other value, or none, is the controller, which
keeps the session out of the project, so there is nothing to warn about.
*/

import { Modal } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import type { AcpHarnessCredential } from "@cocalc/util/ai/runtime";
import { joinUrlPath } from "@cocalc/util/url-path";

export const SHARING_TITLE =
  "Using your Claude subscription in a shared project";

export const SHARING_TEXT =
  "Other people who can run code in this project could deliberately use your subscription while your agent is working. Use it only in projects where you trust every collaborator.";

/** The docs page that explains subscriptions in shared projects in full. */
export const SHARING_DOCS_SLUG = "ai/claude-subscription-in-project";

const ACK_PREFIX = "cocalc:claude-subscription-sharing-ack";

/** The project's collaborators, or undefined when they cannot be read. */
function projectCollaborators(projectId: string): string[] | undefined {
  try {
    const users = redux
      .getStore?.("projects")
      ?.getIn?.(["project_map", projectId, "users"]);
    if (users == null || typeof users.keySeq !== "function") return undefined;
    return users.keySeq().toArray().map(String).sort();
  } catch {
    return undefined;
  }
}

/**
 * Whether the warning applies to this account in this project now, and the
 * collaborator set it applies to ("unknown" when it cannot be read: such a
 * warning is never treated as acknowledged).
 */
export function claudeSubscriptionSharingRisk({
  accountId,
  projectId,
}: {
  accountId?: string;
  projectId?: string;
}): { show: boolean; key: string } {
  // The public site setting, under its site-settings name (the camelCase
  // name exists only in the server-side customize object).
  const runtime = redux
    .getStore?.("customize")
    ?.get?.("claude_subscription_runtime");
  if (runtime !== "project") return { show: false, key: "" };
  if (!projectId) return { show: true, key: "unknown" };
  const users = projectCollaborators(projectId);
  if (users == null) return { show: true, key: "unknown" };
  const others = users.filter((id) => id !== accountId);
  return { show: others.length > 0, key: users.join(",") };
}

function ackKey(accountId: string | undefined, projectId: string): string {
  return `${ACK_PREFIX}:${accountId ?? ""}:${projectId}`;
}

function acknowledged(
  accountId: string | undefined,
  projectId: string,
  key: string,
): boolean {
  if (key === "unknown") return false;
  try {
    return localStorage.getItem(ackKey(accountId, projectId)) === key;
  } catch {
    return false;
  }
}

function acknowledge(
  accountId: string | undefined,
  projectId: string,
  key: string,
): void {
  if (key === "unknown") return;
  try {
    localStorage.setItem(ackKey(accountId, projectId), key);
  } catch {}
}

function SharingText() {
  return (
    <p>
      {SHARING_TEXT}{" "}
      {/* a new tab: the dialog stays open until the user decides */}
      <a
        href={joinUrlPath(appBasePath, "docs", SHARING_DOCS_SLUG)}
        target="_blank"
        rel="noopener noreferrer"
      >
        Learn more about shared projects
      </a>
    </p>
  );
}

/**
 * Whether a turn must first be confirmed (synchronous: a turn that needs no
 * confirmation starts without waiting).
 */
export function needsClaudeSubscriptionSharingConfirm({
  accountId,
  projectId,
  credential,
  pool,
}: {
  accountId?: string;
  projectId?: string;
  credential?: AcpHarnessCredential;
  pool?: boolean;
}): boolean {
  if (credential?.mode !== "account-subscription" && !pool) return false;
  const { show, key } = claudeSubscriptionSharingRisk({ accountId, projectId });
  if (!show) return false;
  return !(projectId && acknowledged(accountId, projectId, key));
}

/**
 * Called before every turn of a Claude agent (at each turn start, so a
 * collaborator added between turns is seen at the next one). Resolves true
 * when the turn may start: the warning does not apply, or the user has
 * acknowledged it for exactly the current collaborators, or acknowledges it
 * now. Nothing is sent before it resolves.
 */
export async function confirmClaudeSubscriptionSharing({
  accountId,
  projectId,
  credential,
  pool,
}: {
  accountId?: string;
  projectId?: string;
  credential?: AcpHarnessCredential;
  /** Auto: the host picks one of the account's subscriptions per turn. */
  pool?: boolean;
}): Promise<boolean> {
  if (
    !needsClaudeSubscriptionSharingConfirm({
      accountId,
      projectId,
      credential,
      pool,
    })
  )
    return true;
  const { key } = claudeSubscriptionSharingRisk({ accountId, projectId });
  return await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: SHARING_TITLE,
      content: <SharingText />,
      okText: "I understand, start the agent",
      cancelText: "Don't start",
      width: 480,
      onOk: () => {
        if (projectId) acknowledge(accountId, projectId, key);
        resolve(true);
      },
      onCancel: () => resolve(false),
    });
  });
}
