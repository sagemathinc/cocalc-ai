import { fromJS } from "immutable";
import {
  readVmToolbox,
  vmToolboxAlias,
  vmToolboxContext,
  MAX_VM_NOTES,
} from "./vm-toolbox-model";

const id = "062225f1-1cc6-4241-976d-64e5dd0c9cf6";
const binding = {
  agentId: id,
  projectId: id,
  path: "agent.chat",
  threadId: "thread",
  vms: [{ vmId: id, notes: "Conserve disk" }],
};

test("normalizes account settings in serialized and Immutable forms", () => {
  expect(readVmToolbox(JSON.stringify([binding]))).toEqual([binding]);
  expect(readVmToolbox(fromJS([binding]))).toEqual([binding]);
  expect(readVmToolbox("not json")).toEqual([]);
  expect(readVmToolbox([{ ...binding, agentId: "old-name" }])).toEqual([]);
});

test("bounds and deduplicates entries and notes", () => {
  const entries = readVmToolbox([
    {
      ...binding,
      vms: [
        { vmId: id, notes: "x".repeat(10000) },
        ...binding.vms,
        { vmId: "$(touch /tmp/no)", notes: "" },
      ],
    },
  ]);
  expect(entries[0].vms).toEqual([
    { vmId: id, notes: "x".repeat(MAX_VM_NOTES) },
  ]);
  expect(() => vmToolboxAlias("--proxy-command=bad")).toThrow();
});

test("context includes attributed notes and qualified observed state, not a readiness guarantee", () => {
  const context = vmToolboxContext(binding.vms, [
    { vmId: id, name: "connector", state: "stopped", observedAt: "2026-09-21" },
  ]);
  expect(context).toContain(`ssh cocalc-vm-${id}`);
  expect(context).toContain('"user_guidance": "Conserve disk"');
  expect(context).toContain('"status": "stopped"');
  expect(context).toContain("not a guarantee");
  expect(context).toContain("Do not start, stop");
  expect(vmToolboxContext(binding.vms, [])).toContain(
    '"status": "unavailable"',
  );
  expect(vmToolboxContext([], [])).toBe("");
});
