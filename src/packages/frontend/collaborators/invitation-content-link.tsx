/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Button } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import {
  collaborationReference,
  collaborationReferenceHref,
} from "@cocalc/util/collaboration-references";
import type { PeopleInvitationTarget } from "@cocalc/util/people-invitations";

/** Context is authored intent, never a redirect URL or proof of current access. */
export function invitationTargetFromContext(
  context: unknown,
  projectId: string | undefined,
): PeopleInvitationTarget | undefined {
  if (!context || typeof context !== "object" || !projectId) return;
  const intent = (
    context as {
      people_invitation?: {
        version?: unknown;
        target?: PeopleInvitationTarget;
      };
    }
  ).people_invitation;
  if (intent?.version !== 1) return;
  return validatedInvitationTarget(intent.target, projectId);
}

function validatedInvitationTarget(value: unknown, projectId: string) {
  if (!value || typeof value !== "object") return;
  const target = value as PeopleInvitationTarget;
  if (target.project_id !== projectId) return;
  const reference = collaborationReference({
    version: 1,
    target,
    display_fallback: target.label ?? target.kind,
  });
  if (!reference) return;
  return { ...reference.target, label: reference.display_fallback };
}

/** Navigation is explicit. The destination rechecks authorization and existence. */
export function InvitationContentLink({
  target,
  projectId,
}: {
  target: PeopleInvitationTarget;
  projectId: string;
}) {
  const safe = validatedInvitationTarget(target, projectId);
  if (!safe) return null;
  const href = collaborationReferenceHref({
    version: 1,
    target: safe,
    display_fallback: safe.label!,
  });
  return (
    <Button
      href={joinUrlPath(appBasePath, href)}
      type="primary"
      aria-label={`Open ${safe.kind}: ${safe.label}`}
    >
      Open {safe.kind}
    </Button>
  );
}
