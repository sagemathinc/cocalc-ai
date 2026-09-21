import {
  harnessSessionControls,
  parseHarnessSessionControls,
  parseHarnessSessionSettings,
} from "./harness-controls";
import { parseAcpHarnessRuntime } from "./runtime";

const session = {
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "a",
      _meta: { secret: "not persisted" },
      options: [
        {
          group: "test",
          name: "Test",
          options: [{ value: "a", name: "A", description: "not persisted" }],
        },
      ],
    },
  ],
};

test("normalizes bounded select catalogs and strips extensions", () => {
  const controls = harnessSessionControls(session);
  expect(controls).toEqual({
    configOptions: [
      {
        id: "model",
        name: "Model",
        currentValue: "a",
        options: [{ value: "a", name: "A" }],
      },
    ],
  });
  expect(parseHarnessSessionControls(controls)).toEqual(controls);
  expect(() =>
    harnessSessionControls({
      configOptions: Array(33).fill(session.configOptions[0]),
    }),
  ).toThrow();
  expect(() =>
    harnessSessionControls({
      configOptions: [{ ...session.configOptions[0], name: "x".repeat(1025) }],
    }),
  ).toThrow();
});

test("configuration options take priority over legacy modes", () => {
  const modes = {
    currentModeId: "code",
    availableModes: [{ id: "code", name: "Code" }],
  };
  expect(harnessSessionControls({ modes }).mode?.currentValue).toBe("code");
  expect(
    harnessSessionControls({ configOptions: [], modes }).mode,
  ).toBeUndefined();
});

test("settings reject unknown fields and duplicate choices and copy caller data", () => {
  const settings = { configOptions: [{ id: "model", value: "a" }] };
  const copy = parseHarnessSessionSettings(settings);
  settings.configOptions[0].value = "b";
  expect(copy.configOptions?.[0].value).toBe("a");
  expect(() =>
    parseHarnessSessionSettings({ env: { TOKEN: "secret" } }),
  ).toThrow();
  expect(() =>
    parseHarnessSessionSettings({
      configOptions: [
        { id: "x", value: "a" },
        { id: "x", value: "b" },
      ],
    }),
  ).toThrow();
  expect(() =>
    parseAcpHarnessRuntime({ version: 1, kind: "acp", profile: {}, settings }),
  ).toThrow();
});
