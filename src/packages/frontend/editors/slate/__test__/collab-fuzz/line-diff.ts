/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Minimal unified-style line diff for fuzzer diagnostics.
export function diffLines(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length - 1;
  let endY = y.length - 1;
  while (endX >= start && endY >= start && x[endX] === y[endY]) {
    endX--;
    endY--;
  }
  const out: string[] = [`@@ line ${start + 1}`];
  for (const line of x.slice(start, endX + 1)) out.push(`- ${line}`);
  for (const line of y.slice(start, endY + 1)) out.push(`+ ${line}`);
  return out.join("\n");
}
