/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ComponentProps, ReactNode } from "react";
import { CollaboratorsPage } from "@cocalc/frontend/collaborators/page";
import { AgentArtifactBrowser } from "./artifact-browser";

interface Props {
  accountId?: string;
  blocked: boolean;
  status?: ReactNode;
  collaboratorsEnabled: boolean;
  collaboratorsOpen: boolean;
  collaborators: Omit<ComponentProps<typeof CollaboratorsPage>, "accountId">;
  artifacts: Omit<ComponentProps<typeof AgentArtifactBrowser>, "accountId">;
}

/** Retain filters, with distinct sibling keys that also reset on account changes. */
export function WorkspaceCollectionPanels({
  accountId,
  blocked,
  status,
  collaboratorsEnabled,
  collaboratorsOpen,
  collaborators,
  artifacts,
}: Props) {
  return (
    <>
      {status}
      {accountId &&
        !blocked &&
        (collaboratorsEnabled ? (
          <CollaboratorsPage
            key={`collaborators:${accountId}`}
            accountId={accountId}
            {...collaborators}
          />
        ) : collaboratorsOpen ? (
          <div style={{ padding: 24 }} role="status">
            {collaborators.navigation}
            The People workspace is not enabled on this site.
          </div>
        ) : null)}
      {accountId && (
        <AgentArtifactBrowser
          key={`artifacts:${accountId}`}
          accountId={accountId}
          {...artifacts}
        />
      )}
    </>
  );
}
