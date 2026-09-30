/*
Known limitation of the core merge (patchflow), found by the collaborative
editing fuzzer. See src/.agents/harden-realtime-collaborative-editing-plan-2026-09-30.md.

Patch graph values apply every patch in time order with fuzzy
diff-match-patch application, including concurrent patches. A deletion whose
context changed concurrently can be relocated onto similar text elsewhere and
still report success, silently deleting someone else's text. This is a
`test.failing` so it starts passing (and must be flipped) once fixed.
*/

import { applyPatch, makePatch } from "patchflow";

describe("core merge limitations", () => {
  test.failing(
    "a concurrent deletion is not applied to similar text elsewhere",
    () => {
      const base =
        "intro\n\n- - tke1q nested\n- tke2q flat\n\nmiddle\n\n- - tke10q nested\n- tke11q flat\n";
      // Client A deletes "tke1q"; concurrently client B un-nests that line.
      const aLocal = base.replace("tke1q", "");
      const bRemote = base.replace("- - tke1q", "- tke1q");
      const [merged] = applyPatch(makePatch(base, aLocal), bRemote);
      // Today the deletion lands on "tke10q" instead.
      expect(merged).toContain("tke10q");
    },
  );
});
