/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useState } from "react";
import { Button } from "antd";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { AddCollaborators } from "./add-collaborators";
import type { CollaboratorInvitePerson } from "./add-collaborators";
import { CollaboratorsModal } from "./modal";

export interface InviteProjectsProps {
  initialProjectIds?: string[];
  person?: CollaboratorInvitePerson;
  onClose: () => void;
  // The parent owns the existing NewProjectCreator modal and return flow.
  onCreateProject?: (selectedProjectIds: string[]) => void;
}

/** Mount once per invitation session; selection and creation never send invites. */
export function InviteProjects({
  initialProjectIds = [],
  person,
  onClose,
  onCreateProject,
}: InviteProjectsProps) {
  const [projects, setProjects] = useState(() =>
    Array.from(new Set(initialProjectIds)).slice(0, 25),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined,
  );

  function close() {
    if (busy) return;
    onClose();
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected && document.activeElement === document.body)
        returnFocus.focus({ preventScroll: true });
    });
  }

  return (
    <CollaboratorsModal
      open
      title="Invite a person to projects"
      onCancel={close}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      footer={
        <Button disabled={busy} onClick={close}>
          Close
        </Button>
      }
    >
      <KeyboardBoundary
        boundary="collaborators-invite-projects"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <p>
          Invite one person to up to 25 projects. Invitations grant access only
          to the selected projects, not your account.
        </p>
        <SelectProject
          ariaLabel="Projects to invite to"
          autoFocus
          multiple
          fullCollaboratorOnly
          maxResults={25}
          maxSelections={25}
          value={projects}
          disabled={confirmed}
          onChange={setProjects}
        />
        {!confirmed ? (
          <div
            style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}
          >
            {onCreateProject && (
              <Button onClick={() => onCreateProject(projects)}>
                Create project
              </Button>
            )}
            <Button
              type="primary"
              disabled={projects.length === 0}
              onClick={() => setConfirmed(true)}
            >
              Choose person
            </Button>
          </div>
        ) : (
          <AddCollaborators
            project_id={projects[0]}
            project_ids={projects}
            initialPerson={person}
            where="collaborators"
            autoFocus
            onBusyChange={setBusy}
          />
        )}
      </KeyboardBoundary>
    </CollaboratorsModal>
  );
}
