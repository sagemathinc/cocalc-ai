/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isDocsActionId, type DocsActionId } from "@cocalc/docs";
import { redux } from "@cocalc/frontend/app-framework";

export const PROJECT_SECRETS_DOCS_ACTION_EVENT =
  "cocalc:docs-action:project-secrets";

export interface ProjectSecretsDocsActionDetail {
  projectId: string;
}

export type DocsActionRevealResult = {
  action_id: DocsActionId;
  opened: true;
  project_id: string;
};

function dispatchProjectSecretsEvent(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ProjectSecretsDocsActionDetail>(
      PROJECT_SECRETS_DOCS_ACTION_EVENT,
      {
        detail: { projectId },
      },
    ),
  );
}

function storeSettingsFlyoutState(projectId: string): void {
  if (typeof window === "undefined") return;
  const key = `${projectId}::flyout`;
  let current: Record<string, unknown> = {};
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed;
      }
    }
  } catch {
    current = {};
  }
  current.expanded = "settings";
  current.settings = ["environment"];
  window.localStorage.setItem(key, JSON.stringify(current));
}

function revealProjectSecrets(projectId: string): DocsActionRevealResult {
  storeSettingsFlyoutState(projectId);

  const pageActions = redux.getActions("page") as
    | {
        set_active_tab?: (
          key: string,
          changeHistory?: boolean,
        ) => Promise<void>;
      }
    | undefined;
  void pageActions?.set_active_tab?.(projectId, false);

  const projectActions = redux.getProjectActions(projectId) as
    | {
        set_active_tab?: (
          key: string,
          opts?: { change_history?: boolean; noFocus?: boolean },
        ) => void;
        setFlyoutExpanded?: (
          name: "settings",
          state: boolean,
          save?: boolean,
        ) => void;
      }
    | undefined;
  projectActions?.set_active_tab?.("settings", {
    change_history: false,
    noFocus: true,
  });
  projectActions?.setFlyoutExpanded?.("settings", true);

  // The settings panel may mount after the action switches tabs. Dispatch a few
  // times so the component can catch the action without needing global UI state.
  dispatchProjectSecretsEvent(projectId);
  setTimeout(() => dispatchProjectSecretsEvent(projectId), 100);
  setTimeout(() => dispatchProjectSecretsEvent(projectId), 500);

  return {
    action_id: "settings.environment.secrets",
    opened: true,
    project_id: projectId,
  };
}

export function revealDocsAction({
  actionId,
  projectId,
}: {
  actionId: string;
  projectId: string;
}): DocsActionRevealResult {
  if (!isDocsActionId(actionId)) {
    throw Error(`unknown docs action '${actionId}'`);
  }
  switch (actionId) {
    case "settings.environment.secrets":
      return revealProjectSecrets(projectId);
  }
}
