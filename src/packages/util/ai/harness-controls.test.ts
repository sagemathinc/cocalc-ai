import {
  defaultClaudeModel,
  harnessSessionControls,
  orderClaudeModelOptions,
  parseHarnessSessionControls,
  parseHarnessSessionSettings,
  resolveClaudeConfigValue,
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

test("retains only valid advertised recommendations and migrates legacy Claude defaults", () => {
  const option = session.configOptions[0];
  const controls = harnessSessionControls({
    configOptions: [
      {
        ...option,
        _meta: {
          jetbrains: { air: { version: 1, recommendedValue: "a" } },
          secret: "discard",
        },
      },
    ],
  });
  expect(controls.configOptions[0].recommendedValue).toBe("a");
  expect(parseHarnessSessionControls(controls)).toEqual(controls);
  expect(JSON.stringify(controls)).not.toContain("secret");
  const control = controls.configOptions[0];
  expect(resolveClaudeConfigValue(control, "default")).toBe("a");
  expect(resolveClaudeConfigValue(control, "explicit")).toBe("explicit");
  expect(resolveClaudeConfigValue({ ...control, id: "other" }, "default")).toBe(
    "default",
  );
  expect(
    resolveClaudeConfigValue(
      { ...control, recommendedValue: undefined },
      "default",
    ),
  ).toBe("default");
  expect(
    resolveClaudeConfigValue(
      {
        ...control,
        options: [...control.options, { value: "default", name: "Default" }],
      },
      "default",
    ),
  ).toBe("default");
  for (const air of [
    { version: 1, recommendedValue: "invented" },
    { version: 0, recommendedValue: "a" },
    { version: "1", recommendedValue: "a" },
    { version: 1, recommendedValue: {} },
  ]) {
    expect(
      harnessSessionControls({
        configOptions: [{ ...option, _meta: { jetbrains: { air } } }],
      }).configOptions[0].recommendedValue,
    ).toBeUndefined();
  }
});

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

test("saved Claude models follow the 1M-context suffix the adapter now uses", () => {
  const model = {
    id: "model",
    name: "Model",
    currentValue: "opus",
    options: [
      { value: "opus", name: "Opus 5.5" },
      { value: "claude-fable-5-1[1m]", name: "Fable 5.1" },
      { value: "sonnet", name: "Sonnet 5.5" },
    ],
  };
  // Claude adapter 0.81 offered `opus[1m]`; 0.84 offers `opus`.
  expect(resolveClaudeConfigValue(model, "opus[1m]")).toBe("opus");
  expect(resolveClaudeConfigValue(model, "claude-fable-5-1")).toBe(
    "claude-fable-5-1[1m]",
  );
  expect(resolveClaudeConfigValue(model, "sonnet")).toBe("sonnet");
  // Unknown values stay as saved, so the caller reports them honestly.
  expect(resolveClaudeConfigValue(model, "haiku[1m]")).toBe("haiku[1m]");
  // Only the model control is migrated this way.
  expect(
    resolveClaudeConfigValue(
      {
        ...model,
        id: "effort",
        options: [{ value: "high", name: "High" }],
      },
      "high[1m]",
    ),
  ).toBe("high[1m]");
});

test("Claude models are ordered newest first, then biggest first", () => {
  const options = [
    { value: "sonnet", name: "Sonnet 5" },
    { value: "claude-fable-5-1[1m]", name: "Fable 5.1" },
    { value: "opus[1m]", name: "Opus 5.5 (1M context)" },
    { value: "haiku", name: "Haiku 4.5" },
    { value: "my-custom-model", name: "Custom" },
    { value: "claude-sonnet-5-5-20261001", name: "claude-sonnet-5-5-20261001" },
  ];
  expect(orderClaudeModelOptions(options).map(({ value }) => value)).toEqual([
    "opus[1m]",
    "claude-sonnet-5-5-20261001",
    "claude-fable-5-1[1m]",
    "sonnet",
    "haiku",
    "my-custom-model",
  ]);
  expect(
    orderClaudeModelOptions([
      { value: "opus", name: "Opus 5" },
      { value: "fable", name: "Fable 5" },
      { value: "default", name: "Default" },
    ]).map(({ value }) => value),
  ).toEqual(["default", "fable", "opus"]);
});

test("the newest Opus is CoCalc's default Claude model", () => {
  const model = {
    id: "model",
    name: "Model",
    currentValue: "sonnet",
    recommendedValue: "sonnet",
    options: [
      { value: "sonnet", name: "Sonnet 5" },
      { value: "claude-fable-5-1[1m]", name: "Fable 5.1" },
      { value: "claude-opus-5-1", name: "Opus 5.1" },
      { value: "opus", name: "Opus 5.5" },
      { value: "haiku", name: "Haiku 4.5" },
    ],
  };
  expect(defaultClaudeModel(model)).toBe("opus");
  // The old default sentinel follows it too.
  expect(resolveClaudeConfigValue(model, "default")).toBe("opus");
  // Without an Opus the harness's own recommendation stays.
  const noOpus = {
    ...model,
    options: model.options.filter(({ name }) => !name.startsWith("Opus")),
  };
  expect(defaultClaudeModel(noOpus)).toBeUndefined();
  expect(resolveClaudeConfigValue(noOpus, "default")).toBe("sonnet");
  expect(defaultClaudeModel({ ...model, id: "effort" })).toBeUndefined();
});
