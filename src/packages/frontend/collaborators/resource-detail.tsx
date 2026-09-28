/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { Icon } from "@cocalc/frontend/components/icon";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { CollaboratorsModal } from "./modal";
import type { CollaborationTarget } from "@cocalc/util/collaborators";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";
import { useDirectory } from "./use-directory";
import { PersonalControls } from "./personal-controls";
import { resolveCollaborationResource } from "./resource-query";
import { participantSummary } from "./resource-list";
import { ShareToConversationButton } from "./share-dialog";
import type { ConversationSearchHit } from "../chat/conversation-search/runner";
import type { EmbeddedThreadHeader } from "../chat/embedding-options";
import { ThreadBadge } from "../chat/thread-badge";
import { resolveAgentHeaderTheme } from "../agents/workspace-header-theme";

const HumanConversation = lazy(async () => ({
  default: (await import("./human-conversation")).HumanConversation,
}));
const LibraryEntry = lazy(async () => ({
  default: (await import("@cocalc/frontend/agents/library-entry")).LibraryEntry,
}));
const EmbeddedConversation = lazy(async () => ({
  default: (await import("./embedded-conversation")).EmbeddedConversation,
}));

export function ResourceDetail({
  api,
  accountId,
  target,
  onChange,
  onBack,
  awaitingIndex = false,
  onManageProject,
  projectTitle,
  onAlias,
  searchHit,
  onResolved,
}: {
  api: DirectoryApi;
  accountId: string;
  target: CollaborationTarget;
  onChange: () => void;
  onBack: () => void;
  awaitingIndex?: boolean;
  onManageProject?: (projectId: string) => void;
  projectTitle?: string;
  onAlias?: (alias: string | null) => void;
  searchHit?: ConversationSearchHit;
  onResolved?: () => void;
}) {
  const [showSource, setShowSource] = useState(false);
  const [audienceOpen, setAudienceOpen] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const aliasTrigger = useRef<HTMLButtonElement>(null);
  const [threadHeader, setThreadHeader] = useState<EmbeddedThreadHeader>();
  const sourceBack = useRef<HTMLButtonElement>(null);
  const sourceOpen = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (showSource) sourceBack.current?.focus();
  }, [showSource]);
  const result = useDirectory(
    collaborationTargetKey(target),
    async (_after, signal) => {
      const resource = await resolveCollaborationResource(
        api,
        target,
        awaitingIndex,
        signal,
      );
      return { items: [resource], coverage: "complete" as const };
    },
    true,
    true,
  );
  const resource = result.page?.items[0];
  const resolvedCallback = useRef(onResolved);
  resolvedCallback.current = onResolved;
  useEffect(() => {
    if (resource) resolvedCallback.current?.();
  }, [resource?.resource_id]);
  const theme = resolveAgentHeaderTheme({
    appearance: threadHeader?.appearance,
    fallbackTitle: resource?.title || "Untitled conversation",
  });
  const aliasCallback = useRef(onAlias);
  aliasCallback.current = onAlias;
  const hasChat =
    resource?.kind === "conversation" || resource?.kind === "agent";
  const alias = resource?.personal?.alias ?? null;
  useEffect(() => {
    if (hasChat) aliasCallback.current?.(alias);
  }, [hasChat, alias]);
  if (result.error)
    return (
      <>
        {target.kind === "conversation" && (
          <Button onClick={onBack}>Back to results</Button>
        )}
        <Alert
          role="alert"
          type="error"
          title="Resource unavailable"
          description={result.error}
          action={<Button onClick={result.refresh}>Retry resource</Button>}
        />
      </>
    );
  const projectName = resource?.project_title || projectTitle || "Project";
  if (!resource)
    return (
      <>
        {target.kind === "conversation" && (
          <Button onClick={onBack}>Back to results</Button>
        )}
        <p role="status">
          {awaitingIndex
            ? "Conversation created. Waiting for its directory entry..."
            : "Checking resource access..."}
        </p>
      </>
    );
  async function openSource() {
    setShowSource(true);
  }
  function closeSource() {
    setShowSource(false);
    requestAnimationFrame(() =>
      (sourceOpen.current ?? heading.current)?.focus(),
    );
  }
  return (
    <>
      {resource.kind === "conversation" ? (
        <header
          className="collaborators-conversation-header"
          style={{
            borderBottom: `1px solid ${theme.primaryColor || UI_COLORS.border}`,
            background: theme.backgroundColor,
            color: theme.textColor,
          }}
        >
          <Button
            type="text"
            aria-label="Back to results"
            icon={<Icon name="arrow-left" />}
            onClick={onBack}
          />
          <div className="collaborators-conversation-heading">
            <h2 ref={heading} tabIndex={-1}>
              {resource.personal?.alias && (
                <>
                  <Button
                    type="text"
                    className="collaborators-heading-button"
                    ref={aliasTrigger}
                    aria-label={`Edit personal alias @${resource.personal.alias}`}
                    aria-haspopup="dialog"
                    onClick={() => setAliasOpen(true)}
                  >
                    @{resource.personal.alias}
                  </Button>
                  {" \u00b7 "}
                </>
              )}
              <Button
                type="text"
                className="collaborators-heading-button"
                aria-label={`Edit Thread Appearance: ${theme.title}`}
                aria-haspopup="dialog"
                disabled={!threadHeader?.editAppearance}
                onClick={threadHeader?.editAppearance}
              >
                <ThreadBadge
                  color={threadHeader?.appearance.thread_color}
                  accentColor={threadHeader?.appearance.thread_accent_color}
                  icon={threadHeader?.appearance.thread_icon}
                  image={threadHeader?.appearance.thread_image}
                  size={26}
                />
                {theme.title}
              </Button>
            </h2>
            <div className="collaborators-conversation-context">
              {onManageProject ? (
                <Button
                  type="link"
                  onClick={() => onManageProject(resource.project_id)}
                  aria-label={`Settings for ${projectName}`}
                >
                  {projectName}
                </Button>
              ) : (
                <span>{projectName}</span>
              )}
              <Button
                type="text"
                onClick={() => setAudienceOpen(true)}
                aria-label="Conversation participants and access"
              >
                <span
                  className="collaborators-participant-avatars"
                  aria-hidden="true"
                >
                  {resource.participant_ids.slice(0, 3).map((id) => (
                    <Avatar key={id} account_id={id} size={20} no_tooltip />
                  ))}
                </span>
                {participantSummary(resource)}
              </Button>
            </div>
          </div>
          <ShareToConversationButton
            api={api}
            accountId={accountId}
            resource={resource}
            renderTrigger={(share) => (
              <PersonalControls
                compact
                api={api}
                resource={resource}
                onChange={() => {
                  result.refresh();
                  onChange();
                }}
                onShare={share}
                onAppearance={threadHeader?.editAppearance}
                aliasOpen={aliasOpen}
                onAliasOpenChange={setAliasOpen}
                aliasTrigger={aliasTrigger}
              />
            )}
          />
          <CollaboratorsModal
            title="Participants and access"
            open={audienceOpen}
            footer={null}
            onCancel={() => setAudienceOpen(false)}
          >
            <KeyboardBoundary boundary="conversation-audience">
              <p>
                <strong>Visible to collaborators in {projectName}.</strong> This
                is not a private recipient list.
              </p>
              <p>
                {participantSummary(resource)}. Participation does not define
                who has access.
              </p>
              <div className="collaborators-actions">
                {resource.participant_ids.map((id) => (
                  <Avatar key={id} account_id={id} size={32} />
                ))}
              </div>
            </KeyboardBoundary>
          </CollaboratorsModal>
        </header>
      ) : (
        <>
          <h2 ref={heading} tabIndex={-1}>
            {resource.title || `Untitled ${resource.kind}`}
          </h2>
          <p>
            <strong>
              Visible to collaborators in{" "}
              {resource.project_title || "this project"}.
            </strong>{" "}
            This is not a private recipient list.
          </p>
          <p>
            {resource.created_by
              ? "Creator attribution is recorded for this resource."
              : "Creator/publisher attribution is unknown for this legacy resource."}
          </p>
          <PersonalControls
            key={collaborationTargetKey(resource)}
            api={api}
            resource={resource}
            onChange={onChange}
          />
          <ShareToConversationButton
            key={`${accountId}:${collaborationTargetKey(resource)}`}
            api={api}
            accountId={accountId}
            resource={resource}
          />
        </>
      )}
      {showSource ? (
        <>
          <Button ref={sourceBack} onClick={closeSource}>
            Back to resource overview
          </Button>
          <Suspense
            fallback={<p role="status">Loading original workbench...</p>}
          >
            <EmbeddedConversation accountId={accountId} resource={resource} />
          </Suspense>
        </>
      ) : resource.kind === "agent" ? (
        <>
          <p>
            This opens the same agent and conversation. Existing execution
            permissions and payment rules still apply; no agent is started by
            this directory.
          </p>
          <Button ref={sourceOpen} onClick={() => void openSource()}>
            Open agent
          </Button>
        </>
      ) : resource.kind === "artifact" ? (
        resource.entry_id ? (
          <Suspense fallback={<p role="status">Loading artifact viewer...</p>}>
            <LibraryEntry
              accountId={accountId}
              projectId={resource.project_id}
              entryId={resource.entry_id}
              agents={[]}
              onBack={onBack}
              onShowConversation={openSource}
            />
          </Suspense>
        ) : (
          <Alert
            role="alert"
            type="warning"
            title="Artifact viewer unavailable"
            description="This legacy artifact has no catalog entry. Open its original conversation to view it."
            action={
              <Button onClick={() => void openSource()}>
                Open original conversation
              </Button>
            }
          />
        )
      ) : (
        <Suspense
          fallback={<p role="status">Loading conversation renderer...</p>}
        >
          <HumanConversation
            searchHit={searchHit}
            accountId={accountId}
            resource={resource}
            onOpenOriginal={openSource}
            onThreadHeader={setThreadHeader}
          />
        </Suspense>
      )}
    </>
  );
}
