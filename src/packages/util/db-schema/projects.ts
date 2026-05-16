/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { callback2 } from "@cocalc/util/async-utils";
import { State } from "@cocalc/util/compute-states";
import { PROJECT_GROUPS } from "@cocalc/util/misc";
import {
  ExecuteCodeOptions,
  ExecuteCodeOptionsAsyncGet,
  ExecuteCodeOutput,
} from "@cocalc/util/types/execute-code";
import { NOTES } from "./crm";
import { SCHEMA as schema } from "./index";
import { Table } from "./types";
export type { SnapshotCounts } from "@cocalc/util/consts/snapshots";

export const MAX_FILENAME_SEARCH_RESULTS = 100;

const THROTTLE_CHANGES = 1000;

export interface ProjectTheme {
  color?: string | null;
  accent_color?: string | null;
  icon?: string | null;
  image_blob?: string | null;
}

function isUserGroup(group: unknown): group is string {
  return typeof group === "string" && PROJECT_GROUPS.includes(group);
}

function currentCollaboratorSponsor(
  account_id: unknown,
  users: Record<string, { group?: string }> | undefined,
): string | undefined {
  if (typeof account_id !== "string" || !account_id) return;
  const group = users?.[account_id]?.group;
  return group === "owner" || group === "collaborator" ? account_id : undefined;
}

function projectOwnerAccountId(
  users: Record<string, { group?: string }> | undefined,
): string | undefined {
  if (users == null) return;
  return (
    Object.keys(users).find(
      (account_id) => users[account_id]?.group === "owner",
    ) ?? Object.keys(users)[0]
  );
}

Table({
  name: "projects",
  rules: {
    primary_key: "project_id",
    //# A lot depends on this being right at all times, e.g., restart state,
    //# so do not use db_standby yet.
    //# It is simply not robust enough.
    //# db_standby : 'safer'

    pg_indexes: [
      "last_edited",
      "created", // TODO: this could have a fillfactor of 100
      "USING GIN (users)", // so get_collaborator_ids is fast
      "lti_id",
      "USING GIN (state)", // so getting all running projects is fast (e.g. for manage-state)
      "((state #>> '{state}'))", // projecting the "state" (running, etc.) for its own index – the GIN index above still causes a scan, which we want to avoid.
      "((state ->> 'state'))", // same reason as above. both syntaxes appear and we have to index both.
      "((state IS NULL))", // not covered by the above
      "((settings ->> 'always_running'))", // to quickly know which projects have this setting
      "((run_quota ->> 'always_running'))", // same reason as above
      "deleted", // in various queries we quickly fiter deleted projects
      "host_id", // project-host placement lookup
      "owning_bay_id", // owning control-plane bay lookup
      "usage_account_id", // membership usage, storage, and egress attribution
      "runtime_sponsor_account_id", // runtime admission, priority, and RAM-limit attribution
    ],

    crm_indexes: ["last_edited"],

    user_query: {
      get: {
        pg_where: ["projects"],
        pg_where_load: ["projects"],
        options: [],
        options_load: [],
        pg_changefeed: "projects",
        throttle_changes: THROTTLE_CHANGES,
        fields: {
          project_id: null,
          name: null,
          title: "",
          description: "",
          users: {},
          deleted: null,
          host_id: null,
          owning_bay_id: null,
          usage_account_id: null,
          runtime_sponsor_account_id: null,
          allow_collaborator_starts_using_sponsor: null,
          allow_collaborator_destructive_storage_actions: null,
          autostart_enabled: null,
          state: null,
          last_edited: null,
          last_active: null,
          last_backup: null,
          theme: null,
        },
      },
      set: {
        // NOTE: for security reasons users CANNOT set the course field via a user query;
        // instead use the api/v2/projects/course/set-course-field api endpoint.
        fields: {
          project_id: "project_write",
          title: true,
          name: true,
          description: true,
          deleted: "project_owner",
          invite_requests: true, // project collabs can modify this (e.g., to remove from it once user added or rejected)
          manage_users_owner_only(obj, db) {
            return db._user_set_query_project_manage_users_owner_only(obj);
          },
          allow_collaborator_starts_using_sponsor(obj, db) {
            return db._user_set_query_project_allow_collaborator_starts_using_sponsor(
              obj,
            );
          },
          allow_collaborator_destructive_storage_actions(obj, db) {
            return db._user_set_query_project_allow_collaborator_destructive_storage_actions(
              obj,
            );
          },
          runtime_sponsor_account_id(obj, db) {
            return db._user_set_query_project_runtime_sponsor_account_id(obj);
          },
          autostart_enabled(obj, db) {
            return db._user_set_query_project_autostart_enabled(obj);
          },
          rootfs_image: true,
          rootfs_image_id: true,
          env: true,
          snapshots: true,
          backups: true,
          launcher: true,
          theme: true,
        },
        required_fields: {
          project_id: true,
        },
        async check_hook(db, obj, account_id, _project_id, cb) {
          // Validate owner/sponsor-managed project policy settings.
          if (
            obj.manage_users_owner_only !== undefined ||
            obj.allow_collaborator_starts_using_sponsor !== undefined ||
            obj.allow_collaborator_destructive_storage_actions !== undefined ||
            obj.runtime_sponsor_account_id !== undefined ||
            obj.autostart_enabled !== undefined ||
            obj.snapshots !== undefined ||
            obj.backups !== undefined
          ) {
            try {
              if (!account_id) {
                throw Error(
                  "account_id is required to change project collaborator policy settings",
                );
              }

              if (obj.manage_users_owner_only !== undefined) {
                const siteSettings =
                  (await callback2(db.get_server_settings_cached, {})) ?? {};
                const siteEnforced =
                  !!siteSettings.strict_collaborator_management;
                if (siteEnforced && obj.manage_users_owner_only !== true) {
                  throw Error(
                    "Collaborator management is enforced by the site administrator and cannot be disabled.",
                  );
                }
              }

              const { rows } = await db.async_query({
                query:
                  "SELECT users, runtime_sponsor_account_id, usage_account_id, allow_collaborator_destructive_storage_actions FROM projects WHERE project_id = $1",
                params: [obj.project_id],
              });
              const users = rows?.[0]?.users ?? {};
              const row = rows?.[0] ?? {};
              const admin = await new Promise<boolean>((resolve, reject) => {
                db.is_admin({
                  account_id,
                  cb: (err, value) => {
                    if (err) {
                      reject(err);
                    } else {
                      resolve(!!value);
                    }
                  },
                });
              });

              const group = users?.[account_id]?.group;
              const owner =
                isUserGroup(group) && group === "owner" ? account_id : null;
              const ownerAccountId = projectOwnerAccountId(users);
              const sponsor =
                currentCollaboratorSponsor(
                  row.runtime_sponsor_account_id,
                  users,
                ) ?? currentCollaboratorSponsor(row.usage_account_id, users);
              if (
                obj.manage_users_owner_only !== undefined &&
                !admin &&
                owner !== account_id
              ) {
                throw Error(
                  "Only project owners and administrators can change collaborator management settings",
                );
              }
              if (
                obj.allow_collaborator_starts_using_sponsor !== undefined &&
                !admin &&
                owner !== account_id &&
                sponsor !== account_id
              ) {
                throw Error(
                  "Only project owners, runtime sponsors, and administrators can change collaborator start settings",
                );
              }
              if (
                obj.autostart_enabled !== undefined &&
                !admin &&
                owner !== account_id
              ) {
                throw Error(
                  "Only project owners and administrators can change automatic start settings",
                );
              }
              if (
                obj.allow_collaborator_destructive_storage_actions !==
                  undefined &&
                !admin &&
                owner !== account_id
              ) {
                throw Error(
                  "Only project owners and administrators can change destructive storage-history settings",
                );
              }
              if (
                (obj.snapshots !== undefined || obj.backups !== undefined) &&
                !admin &&
                owner !== account_id &&
                row.allow_collaborator_destructive_storage_actions !== true
              ) {
                throw Error(
                  "Only project owners can change snapshot and backup schedules unless the owner allows collaborators to manage storage history.",
                );
              }
              if (obj.runtime_sponsor_account_id !== undefined) {
                const nextSponsor = `${obj.runtime_sponsor_account_id ?? ""}`;
                if (!currentCollaboratorSponsor(nextSponsor, users)) {
                  throw Error(
                    "The runtime sponsor must be a current project collaborator",
                  );
                }
                if (
                  !admin &&
                  nextSponsor !== account_id &&
                  !(sponsor === account_id && nextSponsor === ownerAccountId)
                ) {
                  throw Error(
                    "You can only change this project to use your own membership as runtime sponsor, or stop sponsoring it by reverting to the project owner",
                  );
                }
              }
            } catch (err) {
              cb(err.toString());
              return;
            }
          }
          cb();
        },
        before_change(database, old_val, new_val, account_id, cb) {
          database._user_set_query_project_change_before(
            old_val,
            new_val,
            account_id,
            cb,
          );
        },

        on_change(database, old_val, new_val, account_id, cb) {
          database._user_set_query_project_change_after(
            old_val,
            new_val,
            account_id,
            cb,
          );
        },
      },
    },

    project_query: {
      get: {
        pg_where: [{ "project_id = $::UUID": "project_id" }],
        fields: {
          project_id: null,
          title: null,
          description: null,
          status: null,
        },
      },
      set: {
        fields: {
          project_id: "project_id",
          title: true,
          description: true,
          status: true,
        },
      },
    },
  },
  fields: {
    project_id: {
      type: "uuid",
      desc: "The project id, which is the primary key that determines the project.",
    },
    name: {
      type: "string",
      pg_type: "VARCHAR(100)",
      desc: "The optional name of this project.  Must be globally unique (up to case) across all projects with a given *owner*.  It can be between 1 and 100 characters from a-z A-Z 0-9 period and dash.",
      render: { type: "text", maxLen: 100, editable: true },
    },
    title: {
      type: "string",
      desc: "The short title of the project. Should use no special formatting, except hashtags.",
      render: { type: "project_link", project_id: "project_id" },
    },
    description: {
      type: "string",
      desc: "A longer textual description of the project.  This can include hashtags and should be formatted using markdown.",
      render: {
        type: "markdown",
        maxLen: 1024,
        editable: true,
      },
    }, // markdown rendering possibly not implemented
    owning_bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Control-plane bay that authoritatively owns this project record.",
    },
    users: {
      title: "Collaborators",
      type: "map",
      desc: "This is a map from account_id's to {hide:bool, group:'owner'|'collaborator', ssh:{...}}.",
      render: { type: "usersmap", editable: true },
    },
    manage_users_owner_only: {
      type: "boolean",
      // WARNING: This is currently an unfinished work in progress.
      // It does not yet enforce collaborator-management security by itself.
      // Do not rely on this flag as a security control.
      desc: "If true, only project owners can add or remove collaborators. Collaborators can still remove themselves. Disabled by default (undefined or false means current behavior where collaborators can manage other collaborators).",
      render: { type: "boolean", editable: true },
    },
    allow_collaborator_starts_using_sponsor: {
      type: "boolean",
      desc: "If false, ordinary collaborators cannot start or restart this project using the runtime sponsor's membership. Project owners, the runtime sponsor, and administrators can still start it. Defaults to true when unset.",
      render: { type: "boolean", editable: true },
    },
    allow_collaborator_destructive_storage_actions: {
      type: "boolean",
      desc: "If true, collaborators can delete snapshots and backups and can move or archive the project. If unset or false, only project owners and administrators can perform these destructive storage-history actions.",
      render: { type: "boolean", editable: true },
    },
    autostart_enabled: {
      type: "boolean",
      desc: "If false, automatic project starts from SSH, HTTP/app access, Jupyter, terminals, and other wake-on-use paths are blocked. Manual starts remain allowed. Defaults to true when unset.",
      render: { type: "boolean", editable: true },
    },
    invite: {
      type: "map",
      desc: "Map from email addresses to {time:when invite sent, error:error message if there was one}",
      date: ["time"],
    },
    invite_requests: {
      type: "map",
      desc: "This is a map from account_id's to {timestamp:?, message:'i want to join because...'}.",
      date: ["timestamp"],
    },
    deleted: {
      type: "boolean",
      desc: "Whether or not this project is deleted.",
      render: { type: "boolean", editable: true },
    },
    host_id: {
      type: "uuid",
      desc: "Id of the project-host currently assigned to run this project.",
    },
    provisioned: {
      type: "boolean",
      desc: "Whether the project's data is present on its assigned host.",
    },
    provisioned_checked_at: {
      type: "timestamp",
      desc: "When provisioned status was last confirmed by the host.",
    },
    region: {
      type: "string",
      desc: "Project backup region (Cloudflare R2 region code).",
    },
    settings: {
      type: "map",
      desc: 'This is a map that defines the free base quotas that a project has. It is of the form {cores: 1.5, cpu_shares: 768, disk_quota: 1000, memory: 2000, mintime: 36000000, network: 0, ephemeral_state:0, ephemeral_disk:0, always_running:0}.  WARNING: some of the values are strings not numbers in the database right now, e.g., disk_quota:"1000".',
    },
    status: {
      type: "map",
      desc: "This is a map computed by the status command run inside a project, which gives extensive status information about a project. See the exported ProjectStatus interface defined in the code here.",
    },
    state: {
      type: "map",
      desc: 'Lightweight state info for the project runner: {state:"running|stopped|starting|stopping|error", time:"ISO timestamp", error?:string, ip?:string, ...}. The JSON is stored in the "state" column as jsonb. The "state" field inside the JSON is the compute state; the "time" field is when this state was recorded. See COMPUTE_STATES and the ProjectState interface below.',
      date: ["time"],
    },
    last_edited: {
      type: "timestamp",
      desc: "The last time some file was edited in this project.",
    },
    last_started: {
      type: "timestamp",
      desc: "The last time the project started running.",
    },
    last_started_by: {
      type: "uuid",
      desc: "Account id that last explicitly started this project.",
    },
    last_active: {
      type: "map",
      desc: "Map from account_id's to the timestamp of when the user with that account_id touched this project.",
      date: "all",
    },
    created: {
      type: "timestamp",
      desc: "When the project was created.",
    },
    ephemeral: {
      type: "number",
      desc: "If set, number of milliseconds this project may exist after creation.",
    },
    storage: {
      type: "map",
      desc: "(DEPRECATED) This is a map {host:'hostname_of_server', assigned:when first saved here, saved:when last saved here}.",
      date: ["assigned", "saved"],
    },
    last_backup: {
      type: "timestamp",
      desc: "Timestamp of last successful backup using Rustic to off-host storage.",
    },
    storage_request: {
      type: "map",
      desc: "(DEPRECATED) {action:['save', 'close', 'move', 'open'], requested:timestap, pid:?, target:?, started:timestamp, finished:timestamp, err:?}",
      date: ["started", "finished", "requested"],
    },
    course: {
      type: "map",
      desc: "{project_id:[id of project that contains .course file], path:[path to .course file], email_address:[optional email address of student -- used if account_id not known], account_id:[account id of student], required_membership_class:?, student_membership_required_at:?, student_membership_grace_days:?}.",
      date: ["student_membership_required_at", "course_ends_at"],
    },
    storage_server: {
      type: "integer",
      desc: "(DEPRECATED) Number of the Kubernetes storage server with the data for this project: one of 0, 1, 2, ...",
    },
    storage_ready: {
      type: "boolean",
      desc: "(DEPRECATED) Whether storage is ready to be used on the storage server.  Do NOT try to start project until true; this gets set by storage daemon when it notices that run is true.",
    },
    disk_size: {
      type: "integer",
      desc: "Size in megabytes of the project disk.",
    },
    resources: {
      type: "map",
      desc: 'Object of the form {requests:{memory:"30Mi",cpu:"5m"}, limits:{memory:"100Mi",cpu:"300m"}} which is passed to the k8s resources section for this pod.',
    },
    preemptible: {
      type: "boolean",
      desc: "If true, allow to run on preemptible nodes.",
    },
    idle_timeout: {
      type: "integer",
      desc: "If given and nonzero, project will be killed if it is idle for this many **minutes**, where idle *means* that last_edited has not been updated.",
    },
    run_quota: {
      type: "map",
      desc: "If project is running, this is the quota that it is running with.",
    },
    rootfs_image: {
      type: "string",
      desc: "The root filesystem image for this project. This can be an arbitrary Docker image.",
    },
    rootfs_image_id: {
      type: "string",
      desc: "Optional managed RootFS image identifier bound to this project.",
    },
    addons: {
      type: "map",
      desc: "Configure (kucalc specific) addons for projects. (e.g. academic software, license keys, ...)",
    },
    lti_id: {
      type: "array",
      pg_type: "TEXT[]",
      desc: "This is a specific ID derived from an LTI context",
    },
    lti_data: {
      type: "map",
      desc: "extra information related to LTI",
    },
    env: {
      type: "map",
      desc: "Additional environment variables (TS: {[key:string]:string})",
      render: { type: "json", editable: true },
    },
    theme: {
      type: "map",
      desc: "Project appearance theme used throughout list, navigation, and settings UI. Shape: {color, accent_color, icon, image_blob}.",
      render: { type: "json", editable: true },
    },
    launcher: {
      title: "Launcher",
      type: "map",
      desc: "Project-wide launcher defaults (quick create + app defaults).",
      render: { type: "json", editable: true },
    },
    notes: NOTES,
    secret_token: {
      type: "string",
      pg_type: "VARCHAR(256)",
      desc: "Random ephemeral secret token used temporarily by project to authenticate with hub.",
    },
    snapshots: {
      type: "map",
      desc: "See the SnapshotSchedule interface.",
      render: { type: "json", editable: false },
    },
    backups: {
      type: "map",
      desc: "See the SnapshotSchedule interface; same as for snapshots, but for backups.",
      render: { type: "json", editable: false },
    },
    backup_repo_id: {
      type: "uuid",
      desc: "Shared project backup repository id used for this project's backups.",
      render: { type: "text", editable: false },
    },
    usage_account_id: {
      type: "uuid",
      desc: "Optional account id that should be charged membership usage, storage, and managed egress for this project.",
      render: { type: "account", editable: false },
    },
    runtime_sponsor_account_id: {
      type: "uuid",
      desc: "Optional account id whose membership sponsors runtime admission, shared compute priority, and RAM limits for this project. If unset, this defaults to usage_account_id, then the project owner.",
      render: { type: "account", editable: false },
    },
  },
});

export interface ApiKeyInfo {
  name: string;
  trunc: string;
  hash?: string;
  used?: number;
}

if (schema.projects.user_query?.get == null) {
  throw Error("make typescript happy");
}

// Table that provides extended read info about a single project
// but *ONLY* for admin.
Table({
  name: "projects_admin",
  fields: schema.projects.fields,
  rules: {
    primary_key: schema.projects.primary_key,
    virtual: "projects",
    user_query: {
      get: {
        admin: true, // only admins can do get queries on this table
        // (without this, users who have read access could read)
        pg_where: [{ "project_id = $::UUID": "project_id" }],
        fields: schema.projects.user_query.get.fields,
      },
    },
  },
});

/*
Table that enables set queries to the course field of a project.  Only
project owners are allowed to use this table.  The point is that this makes
it possible for the owner of the project to set things, but not for the
collaborators to set those things.
**wARNING:** right now we're not using this since when multiple people add
students to a course and the 'course' field doesn't get properly set,
much confusion and misery arises.... and it is very hard to fix.
In theory a malicious student could tamper with course metadata via this. But if
they could mess with their client, they could easily bypass client-side course
checks anyways.
*/
Table({
  name: "projects_owner",
  rules: {
    virtual: "projects",
    user_query: {
      set: {
        fields: {
          project_id: "project_owner",
          course: true,
        },
      },
    },
  },
  fields: {
    project_id: true,
    course: true,
  },
});

/*

Table that enables any signed-in user to set an invite request.
Later: we can make an index so that users can see all outstanding requests they have made easily.
How to test this from the browser console:
   project_id = '4e0f5bfd-3f1b-4d7b-9dff-456dcf8725b8' // id of a project you have
   invite_requests = {}; invite_requests[smc.client.account_id] = {timestamp:new Date(), message:'please invite me'}
   smc.client.query({cb:console.log, query:{project_invite_requests:{project_id:project_id, invite_requests:invite_requests}}})  // set it
   smc.redux.getStore('projects').get_project(project_id).invite_requests                 // see requests for this project

CURRENTLY NOT USED, but probably will be...

database._user_set_query_project_invite_requests(old_val, new_val, account_id, cb)
 For now don't check anything -- this is how we will make it secure later.
 This will:
   - that user setting this is signed in
   - ensure user only modifies their own entry (for their own id).
   - enforce some hard limit on number of outstanding invites (say 30).
   - enforce limit on size of invite message.
   - sanity check on timestamp
   - with an index as mentioned above we could limit the number of projects
     to which a single user has requested to be invited.

*/
Table({
  name: "project_invite_requests",
  rules: {
    virtual: "projects",
    primary_key: "project_id",
    user_query: {
      set: {
        fields: {
          project_id: true,
          invite_requests: true,
        },
        before_change(_database, _old_val, _new_val, _account_id, cb) {
          cb();
        },
      },
    },
  }, // actual function will be database._user...
  fields: {
    project_id: true,
    invite_requests: true,
  }, // {account_id:{timestamp:?, message:?}, ...}
});

/*
Table to get/set the datastore config in addons.

The main idea is to set/update/delete entries in the dict addons.datastore.[key] = {...}
*/
Table({
  name: "project_datastore",
  rules: {
    virtual: "projects",
    primary_key: "project_id",
    user_query: {
      set: {
        // this also deals with delete requests
        fields: {
          project_id: true,
          addons: true,
        },
        async instead_of_change(
          db,
          _old_value,
          new_val,
          account_id,
          cb,
        ): Promise<void> {
          try {
            // to delete an entry, pretend to set the datastore = {delete: [name]}
            if (typeof new_val.addons.datastore.delete === "string") {
              await db.project_datastore_del(
                account_id,
                new_val.project_id,
                new_val.addons.datastore.delete,
              );
              cb(undefined);
            } else {
              // query should set addons.datastore.[new key] = config, such that we see here
              // new_val = {"project_id":"...","addons":{"datastore":{"key3":{"type":"xxx", ...}}}}
              // which will be merged into the existing addons.datastore dict
              const res = await db.project_datastore_set(
                account_id,
                new_val.project_id,
                new_val.addons.datastore,
              );
              cb(undefined, res);
            }
          } catch (err) {
            cb(`${err}`);
          }
        },
      },
      get: {
        fields: {
          project_id: true,
          addons: true,
        },
        async instead_of_query(db, opts, cb): Promise<void> {
          if (opts.multi) {
            throw Error("'multi' is not implemented");
          }
          try {
            // important: the config dicts for each key must not expose secret credentials!
            // check if opts.query.addons === null ?!
            const data = await db.project_datastore_get(
              opts.account_id,
              opts.query.project_id,
            );
            cb(undefined, data);
          } catch (err) {
            cb(`${err}`);
          }
        },
      },
    },
  },
  fields: {
    project_id: true,
    addons: true,
  },
});

export interface ProjectStatus {
  "project.pid"?: number; // pid of project server process
  "hub-server.port"?: number; // port of tcp server that is listening for conn from hub
  "browser-server.port"?: number; // port listening for http/websocket conn from browser client
  "sage_server.port"?: number; // port where sage server is listening.
  "sage_server.pid"?: number; // pid of sage server process
  start_ts?: number; // timestamp, when project server started
  session_id?: string; // unique identifyer
  version?: number; // version number of project code
  disk_MB?: number; // MB of used disk
  installed?: boolean; // whether code is installed
  memory?: {
    count?: number;
    pss?: number;
    rss?: number;
    swap?: number;
    uss?: number;
  }; // output by smem
}

export interface ProjectState {
  ip?: string; // where the project is running
  error?: string;
  state?: State; // running, stopped, etc.
  time?: Date;
}

Table({
  name: "crm_projects",
  fields: schema.projects.fields,
  rules: {
    primary_key: schema.projects.primary_key,
    virtual: "projects",
    user_query: {
      get: {
        admin: true, // only admins can do get queries on this table
        // (without this, users who have read access could read)
        pg_where: [],
        fields: {
          ...schema.projects.user_query?.get?.fields,
          notes: null,
        },
      },
      set: {
        admin: true,
        fields: {
          project_id: true,
          name: true,
          title: true,
          description: true,
          deleted: true,
          notes: true,
        },
      },
    },
  },
});

export type Datastore = boolean | string[] | undefined;

// in the future, we might want to extend this to include custom environmment variables
export interface EnvVarsRecord {
  inherit?: boolean;
}
export type EnvVars = EnvVarsRecord | undefined;

export interface StudentProjectFunctionality {
  disableActions?: boolean;
  disableJupyterToggleReadonly?: boolean;
  disableJupyterClassicServer?: boolean;
  disableJupyterClassicMode?: boolean;
  disableJupyterLabServer?: boolean;
  disableRServer?: boolean;
  disableVSCodeServer?: boolean;
  disableNetworkWarningBanner?: boolean;
  disablePlutoServer?: boolean;
  disableTerminals?: boolean;
  disableUploads?: boolean;
  disableNetwork?: boolean;
  disableSSH?: boolean;
  disableCollaborators?: boolean;
  disableAI?: boolean;
  disableSomeAI?: boolean;
  disableSharing?: boolean;
}

export interface CourseInfo {
  type: "student" | "shared" | "nbgrader";
  account_id?: string; // account_id of the student that this project is for.
  project_id: string; // the course project, i.e., project with the .course file
  path: string; // path to the .course file in project_id
  student_pay?: boolean;
  institute_pay?: boolean;
  site_license_pay?: boolean;
  required_membership_class?: string;
  student_membership_required_at?: string;
  student_membership_grace_days?: number;
  course_ends_at?: string;
  email_address?: string;
  datastore: Datastore;
  student_project_functionality?: StudentProjectFunctionality;
  envvars?: EnvVars;
  rootfs_image?: string;
  rootfs_image_id?: string;
}

type ExecOptsCommon = {
  project_id: string;
  cb?: Function; // if given use a callback interface *instead* of async.
};

export type ExecOptsBlocking = ExecOptsCommon & {
  filesystem?: boolean; // run in fileserver container; otherwise, runs on main compute container.
  path?: string;
  command: string;
  args?: string[];
  timeout?: number;
  max_output?: number;
  bash?: boolean;
  aggregate?: string | number | { value: string | number };
  err_on_exit?: boolean;
  env?: { [key: string]: string }; // custom environment variables.
  async_call?: ExecuteCodeOptions["async_call"];
};

export type ExecOptsAsync = ExecOptsCommon & {
  async_get?: ExecuteCodeOptionsAsyncGet["async_get"];
  async_stats?: ExecuteCodeOptionsAsyncGet["async_stats"];
  async_await?: ExecuteCodeOptionsAsyncGet["async_await"];
};

export type ExecOpts = ExecOptsBlocking | ExecOptsAsync;

export function isExecOptsBlocking(opts: unknown): opts is ExecOptsBlocking {
  return (
    typeof opts === "object" &&
    typeof (opts as any).project_id === "string" &&
    typeof (opts as any).command === "string"
  );
}

export type ExecOutput = ExecuteCodeOutput & {
  time: number; // time in ms, from user point of view.
};

export interface CreateProjectOptions {
  account_id?: string;
  title?: string;
  description?: string;
  // Optional explicit host placement; if omitted the master will assign.
  host_id?: string;
  // Resource limits/settings to apply when the project runs (mirrors projects.run_quota in Postgres).
  run_quota?: any;
  // (optional) image ID
  image?: string;
  // Optional concatenated SSH public keys (one per line) provided by the master;
  // combined with the project's own ~/.ssh/authorized_keys when serving SSH via project-host.
  authorized_keys?: string;
  rootfs_image?: string;
  rootfs_image_id?: string;
  // Optional backup region (Cloudflare R2 region code).
  region?: string;
  // start running the moment the project is created -- uses more resources, but possibly better user experience
  start?: boolean;

  // admins can specify the project_id - nobody else can -- useful for debugging.
  project_id?: string;
  // if set, project should be treated as expiring after this many milliseconds since creation
  ephemeral?: number;

  // If given, files will be exact clone of those from src_project_id.
  // account_id must be a collab on src_project_id.
  // The implementation is highly efficient using "btrfs subvolume clone".
  // Snapshots are not included in the clone.
  src_project_id?: string;
}
