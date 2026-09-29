/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import type { PeopleInvitationTarget } from "@cocalc/util/people-invitations";
import { resolveInvitationContent } from "./invite-content-target";
import type { InvitationContentSource } from "./invite-content-target";
import type { InviteProjectsDraft } from "./invitation-api";

const InviteProjects = lazy(async () => ({
  default: (await import("./invite-projects")).InviteProjects,
}));
const NewProjectCreator = lazy(async () => ({
  default: (await import("@cocalc/frontend/projects/create-project"))
    .NewProjectCreator,
}));

export function InviteContentButton(props: {
  source: InvitationContentSource;
  title: string;
  compact?: boolean;
}) {
  const accountId = useTypedRedux("account", "account_id");
  const source = props.source;
  const identity =
    "resource_id" in source
      ? [source.project_id, source.kind, source.resource_id]
      : [
          source.project_id,
          source.kind,
          source.chat_path,
          source.thread_id,
          source.artifact_id,
        ];
  return (
    <InviteContentSession
      key={JSON.stringify([accountId, identity])}
      {...props}
      accountId={accountId}
    />
  );
}

function InviteContentSession({
  source,
  title,
  compact,
  accountId,
}: {
  source: InvitationContentSource;
  title: string;
  compact?: boolean;
  accountId?: string;
}) {
  const [target, setTarget] = useState<PeopleInvitationTarget>();
  const [creating, setCreating] = useState(false);
  const draft = useRef<InviteProjectsDraft | undefined>(undefined);
  const selection = useRef<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);

  async function invite() {
    if (!accountId || busy || target) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      const { boundCollaboratorsApi } = await import("./workspace-api");
      const value = await resolveInvitationContent(
        boundCollaboratorsApi(accountId),
        source,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        draft.current = undefined;
        selection.current = [value.project_id];
        setTarget(value);
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(String(err));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <KeyboardBoundary
      boundary="content-invitation"
      stopClickPropagation
      stopMouseDownPropagation
      style={{
        display: "inline-block",
        maxWidth: "100%",
        pointerEvents: "auto",
        position: "relative",
      }}
    >
      <Button
        ref={trigger}
        size={compact ? "small" : undefined}
        type={compact ? "text" : "default"}
        icon={<Icon name="user-plus" />}
        aria-label={`Invite to collaborate on ${title}`}
        title={compact ? "Invite to collaborate" : undefined}
        aria-haspopup="dialog"
        disabled={!accountId}
        loading={busy}
        onClick={() => void invite()}
      >
        {compact ? null : "Invite to collaborate"}
      </Button>
      {busy && <span role="status">Checking content access...</span>}
      {error && (
        <Alert
          role="alert"
          type="error"
          title="Could not invite to this content"
          description={error}
        />
      )}
      {target && !creating && (
        <Suspense fallback={<span role="status">Loading invitation...</span>}>
          <InviteProjects
            initialProjectIds={selection.current}
            initialDraft={draft.current}
            // A resumed draft may intentionally have removed the content target.
            target={draft.current ? undefined : target}
            onClose={() => {
              setTarget(undefined);
              requestAnimationFrame(() => trigger.current?.focus());
            }}
            onCreateProject={(selected, nextDraft) => {
              selection.current = selected;
              draft.current = nextDraft;
              setCreating(true);
            }}
          />
        </Suspense>
      )}
      {target && creating && (
        <Suspense
          fallback={<span role="status">Loading project creation...</span>}
        >
          <NewProjectCreator
            default_value=""
            open
            onClose={() => {
              if (mounted.current) setCreating(false);
            }}
            onCreated={(id) => {
              if (!mounted.current) return;
              // Creation calls onClose next; retain the new identity before
              // restoring the invitation, without opening or starting runtime.
              selection.current = Array.from(
                new Set([...selection.current, id]),
              );
              if (draft.current)
                draft.current = {
                  ...draft.current,
                  createdProjectIds: Array.from(
                    new Set([...draft.current.createdProjectIds, id]),
                  ),
                };
              setCreating(false);
            }}
          />
        </Suspense>
      )}
    </KeyboardBoundary>
  );
}
