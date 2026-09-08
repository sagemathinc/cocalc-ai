import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useWorkingScrollGeneration,
  workingScrollGeneration,
} from "./working-scroll-generation";

const files = [{ path: "a.ts", lines: ["@@ -1 +1 @@", "-old", "+new"] }];
const encoderDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "TextEncoder",
);
const subtleDescriptor = Object.getOwnPropertyDescriptor(
  globalThis.crypto,
  "subtle",
);
beforeEach(() => {
  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    value: TextEncoder,
  });
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: webcrypto.subtle,
  });
});
afterEach(() => {
  if (encoderDescriptor)
    Object.defineProperty(globalThis, "TextEncoder", encoderDescriptor);
  else Reflect.deleteProperty(globalThis, "TextEncoder");
  if (subtleDescriptor)
    Object.defineProperty(globalThis.crypto, "subtle", subtleDescriptor);
  else Reflect.deleteProperty(globalThis.crypto, "subtle");
});

test("identifies exact loaded content including literal paths and patch coordinates", async () => {
  const generation = await workingScrollGeneration(files, false);
  expect(generation).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await workingScrollGeneration(JSON.parse(JSON.stringify(files)), false),
  ).toBe(generation);
  for (const changed of [
    [{ ...files[0], path: " a.ts" }],
    [{ ...files[0], lines: ["@@ -2 +2 @@", "-old", "+new"] }],
    [{ ...files[0], lines: ["@@ -1 +1 @@", "-old", "+different"] }],
  ])
    expect(await workingScrollGeneration(changed, false)).not.toBe(generation);
});

test("declines truncated, over-limit, and unsupported inputs", async () => {
  expect(await workingScrollGeneration(files, true)).toBeUndefined();
  expect(
    await workingScrollGeneration(
      [{ path: "a", lines: Array(20_001).fill("") }],
      false,
    ),
  ).toBeUndefined();
  expect(
    await workingScrollGeneration(
      [{ path: "a", lines: ["\u00e9".repeat(3 * 1024 * 1024)] }],
      false,
    ),
  ).toBeUndefined();
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: undefined,
  });
  expect(await workingScrollGeneration(files, false)).toBeUndefined();
});

test("late digest results cannot restore an older working diff", async () => {
  const resolves: Array<(value: ArrayBuffer) => void> = [];
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: { digest: () => new Promise((resolve) => resolves.push(resolve)) },
  });
  const hook = renderHook(
    ({ input }) => useWorkingScrollGeneration(input, false, true),
    { initialProps: { input: files } },
  );
  const changed = [{ ...files[0], path: "b.ts" }];
  hook.rerender({ input: changed });
  await act(async () => resolves[0](new Uint8Array([1]).buffer));
  expect(hook.result.current).toBeUndefined();
  await act(async () => resolves[1](new Uint8Array([2]).buffer));
  await waitFor(() => expect(hook.result.current).toBe("02"));
});
