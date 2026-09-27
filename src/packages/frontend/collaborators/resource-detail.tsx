/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import type { CollaborationTarget } from "@cocalc/util/collaborators";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";
import { useDirectory } from "./use-directory";
import { PersonalControls } from "./personal-controls";
import { resolveCollaborationResource } from "./resource-query";
import { participantSummary } from "./resource-list";

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
}: {
  api: DirectoryApi;
  accountId: string;
  target: CollaborationTarget;
  onChange: () => void;
  onBack: () => void;
  awaitingIndex?: boolean;
}) {
  const [showSource, setShowSource] = useState(false);
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
  if (result.error)
    return (
      <Alert
        role="alert"
        type="error"
        title="Resource unavailable"
        description={result.error}
        action={<Button onClick={result.refresh}>Retry resource</Button>}
      />
    );
  const resource = result.page?.items[0];
  if (!resource)
    return (
      <p role="status">
        {awaitingIndex
          ? "Conversation created. Waiting for its directory entry..."
          : "Checking resource access..."}
      </p>
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
      <h2 ref={heading} tabIndex={-1}>
        {resource.title || `Untitled ${resource.kind}`}
      </h2>
      <p>
        <strong>
          Visible to collaborators in {resource.project_title || "this project"}
          .
        </strong>{" "}
        This is not a private recipient list.
      </p>
      <p>
        {resource.created_by
          ? "Creator attribution is recorded for this resource."
          : "Creator/publisher attribution is unknown for this legacy resource."}{" "}
        {resource.kind === "conversation" && `${participantSummary(resource)}.`}
      </p>
      <PersonalControls
        key={collaborationTargetKey(resource)}
        api={api}
        resource={resource}
        onChange={onChange}
      />
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
            accountId={accountId}
            resource={resource}
            onOpenOriginal={openSource}
          />
        </Suspense>
      )}
    </>
  );
}
