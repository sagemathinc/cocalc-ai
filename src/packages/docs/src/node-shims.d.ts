/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
};

declare module "node:child_process" {
  export function spawn(
    command: string,
    args: string[],
    options: {
      env?: Record<string, string | undefined>;
      stdio?: string[];
    },
  ): {
    on(event: "close", handler: (code: number | null) => void): void;
    on(event: "error", handler: (err: unknown) => void): void;
    stderr: {
      on(event: "data", handler: (chunk: { toString(): string }) => void): void;
    };
    stdout: {
      on(event: "data", handler: (chunk: { toString(): string }) => void): void;
    };
  };
}
