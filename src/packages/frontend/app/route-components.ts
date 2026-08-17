/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { lazyWithRetry } from "./lazy-with-retry";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { markStartupPhase, markStartupPhaseOnce } from "./startup-phase";
import { getStartupPerformancePolicy } from "./startup-performance-policy";

async function loadRoute<T>(
  name: string,
  loader: () => Promise<T>,
): Promise<T> {
  markStartupPhaseOnce("initial_route_chunk_requested", { route: name });
  try {
    const loaded = await loader();
    markStartupPhase("initial_route_chunk_loaded", { route: name });
    return loaded;
  } catch (err) {
    markStartupPhase("initial_route_chunk_failed", { route: name });
    throw err;
  }
}

export const AccountPage = lazyWithRetry(
  async () =>
    loadRoute("account", async () => ({
      default: (await import("@cocalc/frontend/account/account-page"))
        .AccountPage,
    })),
  "account route",
);

export const AdminPage = lazyWithRetry(
  async () =>
    loadRoute("admin", async () => ({
      default: (await import("@cocalc/frontend/admin")).AdminPage,
    })),
  "admin route",
);

export const AuthPage = lazyWithRetry(
  async () =>
    loadRoute("auth", async () => ({
      default: (await import("@cocalc/frontend/auth")).AuthPage,
    })),
  "authentication route",
);

export const DocsPage = lazyWithRetry(
  async () =>
    loadRoute("docs", async () => ({
      default: (await import("@cocalc/frontend/docs/page")).DocsPage,
    })),
  "docs route",
);

export const FileUsePage = lazyWithRetry(
  async () =>
    loadRoute("file-use", async () => ({
      default: (await import("@cocalc/frontend/file-use/page")).FileUsePage,
    })),
  "file-use route",
);

export const HostsPage = lazyWithRetry(
  async () =>
    loadRoute("hosts", async () => ({
      default: (await import("@cocalc/frontend/hosts/hosts-page")).HostsPage,
    })),
  "hosts route",
);

export const NotificationPage = lazyWithRetry(
  async () =>
    loadRoute("notifications", async () => {
      const [{ ensureNotificationsInitialized }, notifications] =
        await Promise.all([
          import("@cocalc/frontend/notifications/ensure-init"),
          import("@cocalc/frontend/notifications"),
        ]);
      await ensureNotificationsInitialized();
      return { default: notifications.NotificationPage };
    }),
  "notifications route",
);

interface ProjectPageProps {
  is_active: boolean;
  project_id: string;
}

export const ProjectPage = lazyWithRetry<ProjectPageProps>(
  async () =>
    loadRoute("project", async () => {
      const policy = getStartupPerformancePolicy();
      markStartupPhase("project_route_mode_selected", {
        mode: policy.mode,
        reasons: policy.reasons.join(","),
      });
      const [, page] = await Promise.all([
        policy.mode === "reduced"
          ? Promise.resolve()
          : ensureProjectReduxRuntime(),
        policy.mode === "reduced"
          ? import("@cocalc/frontend/project/page/reduced-page")
          : import("@cocalc/frontend/project/page/page"),
      ]);
      return { default: page.ProjectPage };
    }),
  "project route",
);

export const ProjectsPage = lazyWithRetry(
  async () =>
    loadRoute("projects", async () => ({
      default: (await import("@cocalc/frontend/projects/projects-page"))
        .ProjectsPage,
    })),
  "projects route",
);

export const PublicDirectorySharePage = lazyWithRetry(
  async () =>
    loadRoute("share", async () => ({
      default: (
        await import("@cocalc/frontend/share/public-directory-share-page")
      ).PublicDirectorySharePage,
    })),
  "public directory share route",
);

export const SiteLicenseClaimPage = lazyWithRetry(
  async () =>
    loadRoute("claim", async () => ({
      default: (await import("@cocalc/frontend/claim/site-license-page"))
        .default,
    })),
  "site license claim route",
);

export const SshPage = lazyWithRetry(
  async () =>
    loadRoute("ssh", async () => ({
      default: (await import("@cocalc/frontend/ssh")).SshPage,
    })),
  "SSH route",
);
