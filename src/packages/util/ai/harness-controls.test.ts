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

test("rejects duplicate control IDs from a harness or saved metadata", () => {
  expect(() =>
    harnessSessionControls({
      configOptions: [
        session.configOptions[0],
        { ...session.configOptions[0], name: "Other model" },
      ],
    }),
  ).toThrow(/Duplicate ACP control/);
  const controls = harnessSessionControls(session);
  controls.configOptions.push({
    ...controls.configOptions[0],
    name: "Other model",
  });
  expect(() => parseHarnessSessionControls(controls)).toThrow(
    /Duplicate ACP control/,
  );
});

test("rejects duplicate option values across groups and legacy mode IDs", () => {
  expect(() =>
    harnessSessionControls({
      configOptions: [
        {
          ...session.configOptions[0],
          options: [
            ...session.configOptions[0].options,
            { value: "a", name: "A different label" },
          ],
        },
      ],
    }),
  ).toThrow(/Duplicate ACP control/);
  expect(() =>
    harnessSessionControls({
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "code", name: "Code" },
          { id: "code", name: "Other" },
        ],
      },
    }),
  ).toThrow(/Duplicate ACP control/);
});

test("allows repeated display names and values in separate controls", () => {
  const option = {
    ...session.configOptions[0],
    options: [
      { value: "a", name: "Same label" },
      { value: "b", name: "Same label" },
    ],
  };
  const controls = harnessSessionControls({
    configOptions: [option, { ...option, id: "other" }],
  });
  expect(controls.configOptions).toHaveLength(2);
  expect(parseHarnessSessionControls(controls)).toEqual(controls);
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
