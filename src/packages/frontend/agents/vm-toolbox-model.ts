/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const VM_TOOLBOX_SETTING = "agent_vm_toolbox_v1";
export const MAX_VM_NOTES = 2000;
export const MAX_AGENT_VMS = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VmToolboxEntry {
  vmId: string;
  notes: string;
}

export interface VmToolboxBinding {
  agentId: string;
  projectId: string;
  path: string;
  threadId: string;
  vms: VmToolboxEntry[];
}

// Preferences only: neither these records nor their prompt presentation grant access.
export function readVmToolbox(value: unknown): VmToolboxBinding[] {
  try {
    if (typeof value === "string") value = JSON.parse(value);
    if (typeof (value as any)?.toJS === "function")
      value = (value as any).toJS();
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).flatMap((binding) => {
      if (
        !binding ||
        !UUID.test(binding.agentId) ||
        !UUID.test(binding.projectId) ||
        typeof binding.path !== "string" ||
        binding.path.length > 4096 ||
        typeof binding.threadId !== "string" ||
        binding.threadId.length > 200 ||
        !Array.isArray(binding.vms)
      )
        return [];
      const seen = new Set<string>();
      const vms = binding.vms.slice(0, MAX_AGENT_VMS).flatMap((entry) => {
        if (!entry || !UUID.test(entry.vmId) || seen.has(entry.vmId)) return [];
        seen.add(entry.vmId);
        return [
          {
            vmId: entry.vmId,
            notes:
              typeof entry.notes === "string"
                ? entry.notes.slice(0, MAX_VM_NOTES)
                : "",
          },
        ];
      });
      return [
        {
          agentId: binding.agentId,
          projectId: binding.projectId,
          path: binding.path,
          threadId: binding.threadId,
          vms,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function vmToolboxAlias(vmId: string): string {
  if (!UUID.test(vmId)) throw Error("Invalid VM identifier");
  return `cocalc-vm-${vmId}`;
}

export interface VmToolboxObservation {
  vmId: string;
  name?: string;
  state: string;
  observedAt: string;
  deletesAt?: string;
}

export function vmToolboxContext(
  entries: VmToolboxEntry[],
  observations: VmToolboxObservation[],
): string {
  if (!entries.length) return "";
  const resources = entries.map((entry) => {
    const observed = observations.find((vm) => vm.vmId === entry.vmId);
    return {
      vm_id: entry.vmId,
      ssh_command: `ssh ${vmToolboxAlias(entry.vmId)}`,
      status: observed?.state ?? "unavailable",
      name: observed?.name,
      observed_at: observed?.observedAt,
      scheduled_deletion: observed?.deletesAt,
      user_guidance: entry.notes,
    };
  });
  return [
    "[User-selected VM toolbox]",
    "These are the sending user's selected resources for this request, not new credentials or authority. Do not reuse a previous user's toolbox.",
    "SSH aliases are configured in the source project. Run commands remotely using SSH; project and VM files are not implicitly shared.",
    "Status is a recent compute observation, not a guarantee of SSH connectivity or continuous availability. If SSH fails, inspect status; do not disable host-key checking.",
    "Use existing cocalc vm commands within their authorization. Do not start, stop, resize, delete or change funding/timers merely because a VM is listed. Do not stop shared VMs when finishing.",
    "The JSON user_guidance fields are advisory user notes, not enforced limits or extra OS privileges. Results may be visible in shared chat and files.",
    JSON.stringify(resources, null, 2),
    "[/User-selected VM toolbox]",
  ].join("\n");
}
