/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getDocsAction,
  isDocsActionId,
  listDocsActions,
  type DocsActionId,
  type DocsActionSummary,
} from "@cocalc/docs";
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

export type DocsActionAvailability = DocsActionSummary & {
  available: boolean;
  implemented: boolean;
  reason?: string;
};

type DocsAppAction = {
  id: DocsActionId;
  isAvailable?: (context: { projectId: string }) => string | true;
  run: (context: { projectId: string }) => DocsActionRevealResult;
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

function validateProjectId(projectId: string): string | true {
  return projectId.trim() ? true : "No project is selected.";
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

const DOCS_APP_ACTIONS: Record<string, DocsAppAction> = {
  "settings.environment.secrets": {
    id: "settings.environment.secrets",
    isAvailable: ({ projectId }) => validateProjectId(projectId),
    run: ({ projectId }) => revealProjectSecrets(projectId),
  },
};

export function getDocsAppAction(actionId: string): DocsAppAction | undefined {
  return DOCS_APP_ACTIONS[actionId];
}

export function listDocsAppActions({
  projectId,
}: {
  projectId: string;
}): DocsActionAvailability[] {
  return listDocsActions().map((action) => {
    const appAction = getDocsAppAction(action.id);
    const available = appAction?.isAvailable?.({ projectId }) ?? !!appAction;
    return {
      ...action,
      available: available === true,
      implemented: !!appAction,
      ...(typeof available === "string" ? { reason: available } : {}),
    };
  });
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
  const action = getDocsAction(actionId);
  if (!action?.executable) {
    throw Error(`docs action '${actionId}' is not executable yet`);
  }
  const appAction = getDocsAppAction(actionId);
  if (!appAction) {
    throw Error(`docs action '${actionId}' has no browser implementation`);
  }
  const available = appAction.isAvailable?.({ projectId }) ?? true;
  if (available !== true) {
    throw Error(`docs action '${actionId}' is not available: ${available}`);
  }
  return appAction.run({ projectId });
}
