/**
 * Inspect and safely reconfigure courses without opening the course UI.
 */
import { Command } from "commander";

import {
  applyCourseRootfsToManagedProjects,
  openCourseSyncDB,
  readCourseRows,
  reconfigureCourseProjects,
  setCourseRootfs,
  summarizeCourseRows,
} from "../../core/project-course";
import type { ProjectCommandDeps } from "../project";

export function registerProjectCourseCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const { withContext, projectFileFdData, resolveProjectConatClient } = deps;
  const course = project
    .command("course")
    .description("inspect and reconfigure course projects");

  course
    .command("list")
    .description("find .course files in an instructor project")
    .option("-w, --project <project>", "instructor project id or name")
    .option("--path <path>", "directory to search", ".")
    .action(
      async (opts: { project?: string; path?: string }, command: Command) => {
        await withContext(command, "project course list", async (ctx) => {
          const result = await projectFileFdData({
            ctx,
            projectIdentifier: opts.project,
            pattern: "\\.course$",
            path: opts.path ?? ".",
            timeoutMs: ctx.timeoutMs,
            maxBytes: 10_000_000,
            options: ["--type", "f"],
          });
          const exitCode = Number(result.exit_code ?? 1);
          if (exitCode !== 0) {
            throw new Error(
              `${result.stderr ?? "unable to list course files"}`.trim(),
            );
          }
          const paths = `${result.stdout ?? ""}`
            .split(/\r?\n/)
            .map((path) => path.trim().replace(/^\.\//, ""))
            .filter(Boolean)
            .sort();
          return {
            project_id: result.project_id,
            root: opts.path ?? ".",
            count: paths.length,
            paths,
          };
        });
      },
    );

  const config = course
    .command("config")
    .description("inspect or change persisted course configuration");

  config
    .command("show <course-path>")
    .description("show persisted settings and managed project counts")
    .option("-w, --project <project>", "instructor project id or name")
    .action(
      async (
        coursePath: string,
        opts: { project?: string },
        command: Command,
      ) => {
        await withContext(
          command,
          "project course config show",
          async (ctx) => {
            const { project: instructorProject, client } =
              await resolveProjectConatClient(ctx, opts.project);
            const { path, syncdb } = await openCourseSyncDB({
              client,
              project_id: instructorProject.project_id,
              path: coursePath,
              timeout_ms: ctx.timeoutMs,
            });
            try {
              return summarizeCourseRows({
                project_id: instructorProject.project_id,
                path,
                rows: readCourseRows(syncdb),
              });
            } finally {
              await syncdb.close();
            }
          },
        );
      },
    );

  config
    .command("set-rootfs <course-path> <image>")
    .description(
      "persist a student-project RootFS; use --apply to reconfigure existing projects",
    )
    .option("-w, --project <project>", "instructor project id or name")
    .option("--image-id <uuid>", "managed RootFS catalog image id")
    .option(
      "--expected-settings-hash <hash>",
      "fail if settings changed since config show",
    )
    .option(
      "--apply",
      "run the audited course reconfiguration and wait for completion",
    )
    .action(
      async (
        coursePath: string,
        image: string,
        opts: {
          project?: string;
          imageId?: string;
          expectedSettingsHash?: string;
          apply?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "project course config set-rootfs",
          async (ctx) => {
            if (opts.apply) {
              // Force project-scoped callers through account bootstrap before
              // the SyncDB mutation. withContext may retry this callback with
              // account authority when this read rejects.
              await ctx.hub.system.getAccountBay({});
            }
            const { project: instructorProject, client } =
              await resolveProjectConatClient(ctx, opts.project);
            const { path, syncdb } = await openCourseSyncDB({
              client,
              project_id: instructorProject.project_id,
              path: coursePath,
              timeout_ms: ctx.timeoutMs,
            });
            try {
              const configResult = await setCourseRootfs({
                syncdb,
                project_id: instructorProject.project_id,
                path,
                image,
                image_id: opts.imageId,
                expected_settings_hash: opts.expectedSettingsHash,
                account_id: ctx.accountId,
              });
              if (!opts.apply) return configResult;
              const reconfigure = await reconfigureCourseProjects({
                hub: ctx.hub,
                syncdb,
                project_id: instructorProject.project_id,
                path,
                account_id: ctx.accountId,
                timeout_ms: ctx.timeoutMs,
                poll_ms: ctx.pollMs,
              });
              const rootfs = await applyCourseRootfsToManagedProjects({
                hub: ctx.hub,
                course_project_id: instructorProject.project_id,
                rows: readCourseRows(syncdb),
              });
              return { config: configResult, reconfigure, rootfs };
            } finally {
              await syncdb.close();
            }
          },
        );
      },
    );

  course
    .command("reconfigure <course-path>")
    .description(
      "apply persisted settings to all managed projects and wait for completion",
    )
    .option("-w, --project <project>", "instructor project id or name")
    .action(
      async (
        coursePath: string,
        opts: { project?: string },
        command: Command,
      ) => {
        await withContext(
          command,
          "project course reconfigure",
          async (ctx) => {
            const { project: instructorProject, client } =
              await resolveProjectConatClient(ctx, opts.project);
            const { path, syncdb } = await openCourseSyncDB({
              client,
              project_id: instructorProject.project_id,
              path: coursePath,
              timeout_ms: ctx.timeoutMs,
            });
            try {
              return await reconfigureCourseProjects({
                hub: ctx.hub,
                syncdb,
                project_id: instructorProject.project_id,
                path,
                account_id: ctx.accountId,
                timeout_ms: ctx.timeoutMs,
                poll_ms: ctx.pollMs,
              });
            } finally {
              await syncdb.close();
            }
          },
        );
      },
    );
}
