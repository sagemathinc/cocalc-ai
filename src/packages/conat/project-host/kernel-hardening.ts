/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Kernel attack-surface settings of a project host: the host reports them
// (project-host/host-sysctl.ts) and admin health checks the reports
// (server/hosts/kernel-hardening-health.ts). Keep in sync with
// KERNEL_HARDENING_SYSCTLS and KERNEL_HARDENING_MINIMUMS in
// server/cloud/bootstrap/bootstrap.py, which writes the managed ones.
//
// `managed` settings are written by the host. The others are only checked:
// the supported images' defaults are at least this strict, and writing them
// could lower a stricter default (Ubuntu ships unprivileged_bpf_disabled=2 and
// perf_event_paranoid=4).
export const PROJECT_HOST_KERNEL_HARDENING: readonly {
  key: string;
  min?: number;
  max?: number;
  managed?: number;
}[] = [
  // io_uring_setup then fails with EPERM, and libuv falls back to epoll.
  // Existing rings survive the setting, so the host applies it before it
  // starts its services. Project containers get ENOSYS from seccomp
  // regardless.
  { key: "kernel.io_uring_disabled", min: 2, managed: 2 },
  { key: "vm.unprivileged_userfaultfd", max: 0, managed: 0 },
  { key: "kernel.apparmor_restrict_unprivileged_userns", min: 1 },
  { key: "kernel.unprivileged_bpf_disabled", min: 1 },
  { key: "kernel.perf_event_paranoid", min: 3 },
];
