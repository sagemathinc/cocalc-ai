import type { Command } from "commander";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  impersonationReason,
  impersonationSupportContext,
} from "@cocalc/util/impersonation-audit";
import { normalizeCoursePath } from "@cocalc/util/course-path";
import { openCourseSyncDB, readCourseRows } from "../../core/project-course";
import {
  applyReplacement,
  replacementHash,
  validateReplacement,
  type ReplacementState,
  type CourseMember,
} from "../../core/course-account-replacement";
import type { AdminCommandDeps } from "../admin";
import { ENV_AUTH_PROFILE } from "../../../core/auth-config";

type Options = {
  ticketId: string;
  instructor: string;
  project: string;
  path: string;
  studentId: string;
  oldAccount: string;
  newAccount: string;
  reason: string;
  consentReference: string;
  expectedHash?: string;
  recoveryDir?: string;
  commit?: boolean;
};

async function jsonPost(
  origin: string,
  cookie: string,
  path: string,
  body: unknown,
) {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result?.error)
    throw Error(
      `Course support API failed: ${result?.error ?? response.status}`,
    );
  return result;
}

export function registerCourseAccountSupportCommand(
  support: Command,
  deps: AdminCommandDeps,
) {
  support
    .command("replace-course-student-account")
    .description(
      "preview or apply an admin-approved course identity repair using a temporary audited instructor session",
    )
    .requiredOption("--ticket-id <id>", "support ticket recording the repair")
    .requiredOption("--instructor <uuid>", "instructor account to act for")
    .requiredOption("--project <uuid>", "instructor project")
    .requiredOption("--path <path>", "live .course file")
    .requiredOption("--student-id <uuid>", "existing roster student ID")
    .requiredOption("--old-account <uuid>", "expected previous account")
    .requiredOption("--new-account <uuid>", "verified replacement account")
    .requiredOption("--reason <text>", "purpose and operator authorization")
    .requiredOption(
      "--consent-reference <text>",
      "instructor confirmation and operator approval",
    )
    .option("--expected-hash <hash>", "exact state hash returned by preview")
    .option(
      "--recovery-dir <path>",
      "new private directory for pre-change state and durable progress journal",
    )
    .option("--commit", "apply the previewed repair", false)
    .action(async (opts: Options, command: Command) => {
      for (const id of [
        opts.instructor,
        opts.project,
        opts.studentId,
        opts.oldAccount,
        opts.newAccount,
      ]) {
        if (!deps.isValidUUID(id))
          throw Error("Account, project and student IDs must be UUIDs");
      }
      const reason = impersonationReason(opts.reason);
      const consent = impersonationSupportContext({
        support_ticket_id: Number(opts.ticketId),
        consent_reference: opts.consentReference,
      });
      if (opts.commit && (!opts.expectedHash || !opts.recoveryDir))
        throw Error("--commit requires --expected-hash and --recovery-dir");
      await deps.withContext(
        command,
        "admin support replace-course-student-account",
        async (admin) => {
          const identities = [] as Record<string, any>[];
          for (const id of [opts.oldAccount, opts.newAccount]) {
            const matches = await admin.hub.system.userSearch({
              query: id,
              admin: true,
              limit: 2,
            });
            const account = matches.find((a: any) => a.account_id === id);
            if (
              !account ||
              account.banned ||
              (id === opts.newAccount && !account.email_address_verified)
            )
              throw Error(
                "Replacement requires existing non-banned accounts and a verified new email",
              );
            identities.push({
              account_id: id,
              email_address: account.email_address,
              name: account.display_name ?? account.name ?? account.first_name,
            });
          }
          const grant = await admin.hub.system.createImpersonationGrant({
            subject_account_id: opts.instructor,
            reason,
            ...consent,
          });
          const origin = new URL(grant.home_bay_url ?? admin.apiBaseUrl).origin;
          const url = new URL(grant.url, admin.apiBaseUrl);
          // The grant API supplies the authoritative home-bay destination. Never forward the admin cookie.
          if (url.origin !== origin)
            throw Error("Grant must be consumed at its authoritative home bay");
          url.searchParams.set("confirm", "1");
          const response = await fetch(url, {
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          });
          const cookie = response.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .filter((c) => !c.endsWith("="))
            .join("; ");
          if (!response.ok || !cookie.includes("remember_me="))
            throw Error(
              "Unable to open temporary support session at the instructor home bay",
            );
          let ctx: any,
            syncdb: any,
            journal: Awaited<ReturnType<typeof open>> | undefined;
          let recoveryDir: string | undefined;
          const operation = randomUUID();
          try {
            ctx = await deps.contextForGlobals!({
              profile: ENV_AUTH_PROFILE,
              api: origin,
              cookie,
              accountId: opts.instructor,
              disableEnvAuthDefaults: true,
            });
            if (
              ctx.accountId !== opts.instructor ||
              ctx.remote.user?.account_id !== opts.instructor
            )
              throw Error("Unexpected support session identity");
            // The legacy set-course-info HTTP API is local-bay only. Fail closed until it has a routed RPC equivalent.
            const checkBay = async (project_id: string) => {
              if (!deps.isValidUUID(project_id))
                throw Error("Invalid managed project UUID");
              // The ordinary routing lookup excludes hidden projects. Query the
              // explicit home bay, then still enforce instructor ACLs below.
              const result = await admin.hub.adminDb.query({
                bay_id: grant.subject_home_bay_id,
                sql: `SELECT owning_bay_id, deleted FROM projects WHERE project_id='${project_id}'::uuid`,
                reason: `Support ${opts.ticketId} course repair ownership preflight: ${reason}`,
                limit: 1,
              });
              if (
                result.bay_id !== grant.subject_home_bay_id ||
                result.rows.length !== 1 ||
                result.rows[0][0] !== grant.subject_home_bay_id ||
                result.rows[0][1] === true
              )
                throw Error(
                  "Cross-bay, missing or deleted project: course repair requires projects owned by the instructor home bay",
                );
            };
            await checkBay(opts.project);
            const { client } = await deps.resolveProjectConatClient!(
              ctx,
              opts.project,
            );
            const path = normalizeCoursePath(opts.path);
            if (!path.endsWith(".course"))
              throw Error("Expected an existing .course file");
            const { fs } = await deps.resolveProjectFilesystem!(
              ctx,
              opts.project,
            );
            const info = await fs.stat(path);
            if (!info.isFile())
              throw Error("Expected an existing .course file");
            syncdb = (
              await openCourseSyncDB({ client, project_id: opts.project, path })
            ).syncdb;
            const members = async (id: string): Promise<CourseMember[]> =>
              (await ctx.hub.projects.listCollaborators({ project_id: id }))
                .map((m: any) => ({ account_id: m.account_id, group: m.group }))
                .sort((a: CourseMember, b: CourseMember) =>
                  a.account_id.localeCompare(b.account_id),
                );
            const inspect = async (): Promise<ReplacementState> => {
              const rows = readCourseRows(syncdb);
              const student = rows.find(
                (r) =>
                  r.table === "students" && r.student_id === opts.studentId,
              );
              const shared = rows.find(
                (r) => r.table === "settings",
              )?.shared_project_id;
              const projects: ReplacementState["projects"] = [];
              for (const id of [
                ...new Set([student?.project_id, shared].filter(Boolean)),
              ].sort()) {
                await checkBay(id);
                projects.push({
                  project_id: id,
                  course: await ctx.hub.projects.getProjectCourseInfo({
                    project_id: id,
                  }),
                  members: await members(id),
                });
              }
              const instructors = await members(opts.project);
              if (
                !instructors.some(
                  (m) =>
                    m.account_id === opts.instructor &&
                    ["owner", "collaborator"].includes(m.group),
                )
              )
                throw Error("Selected account is not an instructor");
              return {
                course_project_id: opts.project,
                path,
                student_id: opts.studentId,
                old_account_id: opts.oldAccount,
                new_account_id: opts.newAccount,
                rows,
                instructors,
                projects,
              };
            };
            const state = await inspect();
            validateReplacement(state);
            const hash = replacementHash(state);
            const preview = {
              state_hash: hash,
              identities,
              student_id: opts.studentId,
              project_ids: state.projects.map((p) => p.project_id),
              instructor: opts.instructor,
              commit: false,
            };
            if (!opts.commit) return preview;
            if (hash !== opts.expectedHash)
              throw Error("Preview is stale; inspect again");
            recoveryDir = resolve(opts.recoveryDir!);
            await mkdir(recoveryDir, { mode: 0o700 });
            await writeFile(
              join(recoveryDir, "before.json"),
              JSON.stringify(
                {
                  operation,
                  reason,
                  ...consent,
                  actor_account_id: admin.accountId,
                  identities,
                  state,
                },
                null,
                2,
              ),
              { mode: 0o600, flag: "wx" },
            );
            journal = await open(
              join(recoveryDir, "progress.jsonl"),
              "wx",
              0o600,
            );
            const checkpoint = async (phase: string) => {
              await journal!.write(
                `${JSON.stringify({ operation, phase, time: new Date().toISOString() })}\n`,
              );
              await journal!.sync();
            };
            const result = await applyReplacement(state, hash, {
              inspect,
              checkpoint,
              snapshot: async (project_id) => {
                await ctx.hub.projects.createSnapshot({
                  project_id,
                  name: `support-${opts.ticketId}-account-${operation}`,
                });
              },
              add: async (project_id, invitee_account_id) => {
                await admin.hub.projects.createCollabInvite({
                  project_id,
                  invitee_account_id,
                  direct: true,
                  message: `Support ${opts.ticketId}: ${reason}`,
                });
              },
              setStudent: async (account_id) => {
                syncdb.set({
                  table: "students",
                  student_id: opts.studentId,
                  account_id,
                });
                syncdb.commit({
                  meta: {
                    action: "support-replace-course-student-account",
                    operation,
                    actor_account_id: admin.accountId,
                    ...consent,
                    old_account_id: opts.oldAccount,
                    new_account_id: opts.newAccount,
                  },
                });
                await syncdb.save();
                await syncdb.save_to_disk();
              },
              setCourse: async (project_id, course) => {
                await jsonPost(
                  origin,
                  cookie,
                  "/api/v2/projects/course/set-course-info",
                  { project_id, course },
                );
              },
              remove: async (project_id, account_id) => {
                await ctx.hub.projects.removeCollaborator({
                  opts: { project_id, account_id },
                });
              },
            });
            return {
              ...result,
              operation,
              recovery_dir: recoveryDir,
              commit: true,
              note: "Project access and association verified; membership entitlement is unchanged. No customer message sent.",
            };
          } catch (err) {
            if (journal) {
              await journal.write(
                `${JSON.stringify({ phase: "failed", time: new Date().toISOString() })}\n`,
              );
              await journal.sync();
            }
            throw Error(
              `${err instanceof Error ? err.message : err}${recoveryDir ? `; recovery state: ${recoveryDir}` : ""}`,
            );
          } finally {
            await journal?.close();
            try {
              await syncdb?.close();
            } finally {
              try {
                if (ctx) await deps.closeCommandContext!(ctx);
              } finally {
                await jsonPost(origin, cookie, "/api/v2/accounts/sign-out", {
                  all: false,
                });
              }
            }
          }
        },
      );
    });
}
