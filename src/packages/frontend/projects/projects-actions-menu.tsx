/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Suspense, useCallback, useState, type ComponentType } from "react";

import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import { CocalcErrorBoundary } from "@cocalc/frontend/app/error-boundary";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { Icon } from "@cocalc/frontend/components";

import { ProjectActionsTrigger } from "./project-actions-trigger";
import type {
  ProjectActionsMenuContentProps,
  ProjectActionsMenuProps,
} from "./projects-actions-menu-content";

let contentPromise:
  | Promise<{ default: ComponentType<ProjectActionsMenuContentProps> }>
  | undefined;

function loadProjectActionsMenuContent() {
  contentPromise ??= (async () => {
    const [, content] = await Promise.all([
      ensureProjectReduxRuntime(),
      import("./projects-actions-menu-content"),
    ]);
    return { default: content.ProjectActionsMenuContent };
  })().catch((error) => {
    contentPromise = undefined;
    throw error;
  });
  return contentPromise;
}

const ProjectActionsMenuContent = lazyWithRetry<ProjectActionsMenuContentProps>(
  loadProjectActionsMenuContent,
  "project actions menu",
);

export function ProjectActionsMenu(props: ProjectActionsMenuProps) {
  const [hydrated, setHydrated] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(false);

  const focusTrigger = useCallback(
    (trigger: HTMLButtonElement | null) => {
      if (trigger != null && restoreFocus) {
        trigger.focus();
      }
    },
    [restoreFocus],
  );

  function preload() {
    void loadProjectActionsMenuContent().catch(() => {
      // lazyWithRetry presents the loading error if activation also fails.
    });
  }

  if (!hydrated) {
    return (
      <ProjectActionsTrigger
        aria-expanded={false}
        aria-haspopup="menu"
        onFocus={preload}
        onClick={(event) => {
          event.stopPropagation();
          setRestoreFocus(true);
          setHydrated(true);
        }}
      />
    );
  }

  return (
    <CocalcErrorBoundary
      autoRetry={false}
      resetKeys={[props.record.project_id]}
      scope="projects.actions-menu"
    >
      <Suspense
        fallback={
          <ProjectActionsTrigger
            ref={focusTrigger}
            aria-busy="true"
            aria-expanded={false}
            aria-haspopup="menu"
            icon={<Icon name="spinner" spin />}
          />
        }
      >
        <ProjectActionsMenuContent
          {...props}
          defaultOpen
          restoreFocus={restoreFocus}
        />
      </Suspense>
    </CocalcErrorBoundary>
  );
}
