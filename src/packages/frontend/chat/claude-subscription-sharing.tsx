/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
When a Claude agent paid by the user's own Claude subscription runs in the
project (the site's "project" Claude subscription runtime), another process
in that project could deliberately use the session while it runs. CoCalc
cannot protect against a collaborator who sets out to do that, so the user is
told plainly before any turn in a project with other collaborators, and again
whenever the collaborators change. If the collaborators cannot be read, the
warning is shown.
*/

import { Alert, Modal } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { AcpHarnessCredential } from "@cocalc/util/ai/runtime";

export const SHARING_TITLE =
  "Using your Claude or Codex subscription in a shared project";

export const SHARING_TEXT = [
  "While your agent is working, and for a short time afterwards, another process in this project could deliberately obtain credentials or temporary access material from files, environment or memory available to your agent, and use it to send requests billed to your subscription. This doesn't happen by accident: it takes intentional circumvention, which violates Anthropic's and OpenAI's terms of service.",
  "Your Claude subscription credentials themselves are never placed in the project.",
  "CoCalc cannot protect you from a collaborator who sets out to do this, so use your subscription only in projects where you trust every collaborator.",
];

export const SHARING_SHORT_TEXT =
  "Another process in this project could deliberately use your subscription while your agent works, which violates Anthropic's and OpenAI's terms. CoCalc cannot protect you from a collaborator who sets out to do this.";

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
  const runtime = redux
    .getStore?.("customize")
    ?.get?.("claudeSubscriptionRuntime");
  // The controller runtime keeps the session out of the project.
  if (runtime === "controller") return { show: false, key: "" };
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
    <div>
      {SHARING_TEXT.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </div>
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
      width: 560,
      onOk: () => {
        if (projectId) acknowledge(accountId, projectId, key);
        resolve(true);
      },
      onCancel: () => resolve(false),
    });
  });
}

/** Shown in the agent panel while a subscription session applies here. */
export function ClaudeSubscriptionSharingBanner({
  accountId,
  projectId,
}: {
  accountId?: string;
  projectId: string;
}) {
  // subscribed, so a collaborator added or removed shows at once
  useTypedRedux("projects", "project_map");
  const { show } = claudeSubscriptionSharingRisk({ accountId, projectId });
  if (!show) return null;
  return (
    <Alert
      type="warning"
      showIcon
      banner
      message={SHARING_TITLE}
      description={SHARING_SHORT_TEXT}
    />
  );
}
