import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerBayCommand } from "./bay";

test("bay list returns the hub bay rows", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            listBays: async () => [
              {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
              },
            ],
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "list"]);

  assert.equal(captured?.[0]?.bay_id, "bay-0");
});

test("bay show filters one bay from the hub list", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            listBays: async () => [
              {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
              },
            ],
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "show", "bay-0"]);

  assert.equal(captured?.bay_id, "bay-0");
});
