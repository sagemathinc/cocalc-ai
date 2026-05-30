/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon, projectHostActionParameters } from "../helpers";
import {
  PROJECT_HOSTS_BODY,
  PROJECT_HOST_ACCESS_BODY,
  PROJECT_HOST_CHANGE_RULES_BODY,
  PROJECT_HOST_LIFECYCLE_BODY,
  PROJECT_HOST_LOGS_BODY,
  PROJECT_HOST_MOVE_BODY,
  PROJECT_HOST_RELIABILITY_BODY,
  PROJECT_HOST_SHARED_SCRATCH_BODY,
  PROJECT_HOST_SOFTWARE_LIFECYCLE_BODY,
  PROJECT_HOST_SPOT_RECOVERY_BODY,
  PROJECT_HOST_STORAGE_BODY,
} from "../content";

export const HOSTS_ENTRIES: DocsEntry[] = [
  {
    actions: [
      {
        description: "Open the top-level Project Hosts page.",
        executable: true,
        id: "hosts.open",
        label: "Open project hosts",
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOSTS_BODY.trim(),
    category: "Project hosts",
    id: "hosts.project-hosts",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "A project host running several project folders",
    ),
    lastReviewed: "2026-05-24",
    slug: "hosts/project-hosts",
    status: "ready",
    summary:
      "Run projects on dedicated or cloud-backed compute for courses, research, and agent sandboxes.",
    title: "Use project hosts",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Access tab.",
        executable: true,
        id: "hosts.access.open",
        label: "Open host access",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_ACCESS_BODY.trim(),
    category: "Project hosts",
    id: "hosts.access-and-ram",
    image: docsIcon(
      "/public/docs/project-hosts-access-ram-9245deeb.webp",
      "A project host access panel with delegated users and resource limits",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/access-and-ram",
    status: "ready",
    summary:
      "Delegate host access, understand shared-pool tiers, and set per-project RAM policy.",
    title: "Manage project host access and RAM",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Projects tab.",
        executable: true,
        id: "hosts.move.open",
        label: "Open host projects",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_MOVE_BODY.trim(),
    category: "Project hosts",
    id: "hosts.move-projects",
    image: docsIcon(
      "/public/docs/project-hosts-move-47c2a6e8.webp",
      "A project folder moving between two project hosts across regions",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/move-projects",
    status: "ready",
    summary:
      "Move projects between hosts while accounting for backups, snapshots, region changes, and SSH.",
    title: "Move projects between hosts",
  },
  {
    actions: [
      {
        description: "Open a project host drawer.",
        executable: true,
        id: "hosts.lifecycle.open",
        label: "Open host lifecycle",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_LIFECYCLE_BODY.trim(),
    category: "Project hosts",
    id: "hosts.lifecycle",
    image: docsIcon(
      "/public/docs/project-hosts-lifecycle-6d603bd0.webp",
      "A project host with start stop restart deprovision and delete controls",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/lifecycle",
    status: "ready",
    summary:
      "Understand start, stop, restart, drain, deprovision, and delete actions for project hosts.",
    title: "Project host lifecycle actions",
  },
  {
    actions: [
      {
        description: "Open a project host drawer.",
        executable: true,
        id: "hosts.spot-recovery.open",
        label: "Open host details",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_SPOT_RECOVERY_BODY.trim(),
    category: "Project hosts",
    id: "hosts.spot-recovery",
    image: docsIcon(
      "/public/docs/project-hosts-spot-recovery-75af618c.webp",
      "A spot host recovering through retries and standard fallback",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/spot-recovery",
    status: "ready",
    summary:
      "Explain spot retry windows, standard fallback, probes, and returning from fallback to spot.",
    title: "Spot recovery strategy for project hosts",
  },
  {
    actions: [
      {
        description: "Open a project host drawer.",
        executable: true,
        id: "hosts.change-rules.open",
        label: "Open host details",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_CHANGE_RULES_BODY.trim(),
    category: "Project hosts",
    id: "hosts.change-rules",
    image: docsIcon(
      "/public/docs/project-hosts-change-rules-40b02147.webp",
      "Project host settings grouped by online change restart and deprovision",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/change-rules",
    status: "ready",
    summary:
      "Know which host edits are online, which require restart, and which require deprovision.",
    title: "What can change on a project host and when",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Reliability tab.",
        executable: true,
        id: "hosts.reliability.open",
        label: "Open reliability",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_RELIABILITY_BODY.trim(),
    category: "Project hosts",
    id: "hosts.reliability",
    image: docsIcon(
      "/public/docs/project-hosts-reliability-e1f428a6.webp",
      "A project host with a reliability gauge and recent availability bars",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/reliability",
    status: "ready",
    summary:
      "Read host reliability, availability, outage exposure, planned downtime, and day-grid signals.",
    title: "Understand project host reliability",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Runtime tab.",
        executable: true,
        id: "hosts.runtime.open",
        label: "Open runtime",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_SOFTWARE_LIFECYCLE_BODY.trim(),
    category: "Project hosts",
    id: "hosts.software-lifecycle",
    image: docsIcon(
      "/public/docs/project-hosts-software-lifecycle-29c58052.webp",
      "A project host with software packages daemon health and reconcile arrows",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/software-lifecycle",
    status: "ready",
    summary:
      "Understand runtime software, managed daemons, reconcile, upgrades, drift, and rollbacks.",
    title: "Project host software and daemon lifecycle",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Storage tab.",
        executable: true,
        id: "hosts.storage.open",
        label: "Open storage",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_STORAGE_BODY.trim(),
    category: "Project hosts",
    id: "hosts.storage",
    image: docsIcon(
      "/public/docs/project-hosts-storage-cad76e1f.webp",
      "A project host with disks backups snapshots and protected project folders",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/storage",
    status: "ready",
    summary:
      "Understand host disk capacity, storage mode, backups, snapshots, and online disk growth.",
    title: "Project host storage, backups, and snapshots",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Storage tab.",
        executable: true,
        id: "hosts.scratch.open",
        label: "Open scratch settings",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_SHARED_SCRATCH_BODY.trim(),
    category: "Project hosts",
    id: "hosts.shared-scratch",
    image: docsIcon(
      "/public/docs/project-hosts-shared-scratch-8409afa7.webp",
      "A host-scoped scratch disk shared by several project folders",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/shared-scratch",
    status: "ready",
    summary:
      "Use host-scoped /scratch storage without confusing it with project storage, backups, or moves.",
    title: "Shared scratch disks on project hosts",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Logs tab.",
        executable: true,
        id: "hosts.logs.open",
        label: "Open logs",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_LOGS_BODY.trim(),
    category: "Project hosts",
    id: "hosts.logs",
    image: docsIcon(
      "/public/docs/project-hosts-logs-df53d17e.webp",
      "A project host with logs diagnostics warnings and a magnifying glass",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/logs",
    status: "ready",
    summary:
      "Use host logs with runtime and reliability state to debug provisioning, daemon, and provider issues.",
    title: "Debug project hosts with logs",
  },
];
