/** Bounded display metadata, not launch configuration or an authorization grant. */
export interface HarnessSelectControl {
  id: string;
  name: string;
  currentValue: string;
  recommendedValue?: string;
  options: { value: string; name: string }[];
}

export interface HarnessSessionControls {
  configOptions: HarnessSelectControl[];
  mode?: HarnessSelectControl;
}

export interface HarnessSessionSettings {
  modeId?: string;
  configOptions?: { id: string; value: string }[];
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    /[\x00-\x1f]/.test(value)
  )
    throw Error("Invalid ACP control text");
  return value;
}

function list(value: unknown, max: number): any[] {
  if (!Array.isArray(value) || value.length > max)
    throw Error("Invalid ACP control list");
  return value;
}

/** Strip descriptions/unknown extensions and bound the persisted display catalog. */
export function harnessSessionControls(session: {
  configOptions?: unknown;
  modes?: unknown;
}): HarnessSessionControls {
  const configOptions = list(session.configOptions ?? [], 32).flatMap(
    (option) => {
      // Boolean options are not advertised by this client yet.
      if (option?.type !== "select") return [];
      const options = list(option.options, 1024).flatMap((item) =>
        item?.group == null ? [item] : list(item.options, 1024),
      );
      if (options.length > 1024) throw Error("ACP control catalog too large");
      const air = option._meta?.jetbrains?.air;
      const recommendedValue =
        Number.isInteger(air?.version) && air.version >= 1
          ? air.recommendedValue
          : undefined;
      return [
        {
          id: text(option.id),
          name: text(option.name),
          currentValue: text(option.currentValue),
          ...(typeof recommendedValue === "string" &&
          options.some((item) => item?.value === recommendedValue)
            ? { recommendedValue: text(recommendedValue) }
            : {}),
          options: options.map((item) => ({
            value: text(item?.value),
            name: text(item?.name),
          })),
        },
      ];
    },
  );
  const modes = session.modes as any;
  const result: HarnessSessionControls = { configOptions };
  // ACP prefers configOptions when provided, including an explicitly empty list.
  if (session.configOptions == null && modes != null) {
    result.mode = {
      id: "mode",
      name: "Harness mode",
      currentValue: text(modes.currentModeId),
      options: list(modes.availableModes, 128).map((mode) => ({
        value: text(mode?.id),
        name: text(mode?.name),
      })),
    };
  }
  if (new Set(configOptions.map(({ id }) => id)).size !== configOptions.length)
    throw Error("Duplicate ACP control identifier");
  for (const control of [
    ...configOptions,
    ...(result.mode ? [result.mode] : []),
  ]) {
    if (
      new Set(control.options.map(({ value }) => value)).size !==
      control.options.length
    )
      throw Error("Duplicate ACP control option value");
  }
  if (JSON.stringify(result).length > 256 * 1024)
    throw Error("ACP control catalog too large");
  return result;
}

const ONE_MILLION_CONTEXT = "[1m]";

// Claude model families, biggest first.
const CLAUDE_FAMILIES = ["fable", "opus", "sonnet", "haiku"];

function claudeModelRank(option: { value: string; name: string }): {
  family: number;
  version?: [number, number];
} {
  const value = option.value.toLowerCase().replace(/\[\d+m\]/g, "");
  const words = `${option.name.toLowerCase()} ${value}`;
  const family = CLAUDE_FAMILIES.findIndex((name) =>
    new RegExp(`\\b${name}\\b`).test(words),
  );
  // "Opus 5.5 (1M context)", else an id such as claude-opus-5-5-20260101.
  const version = /\b(\d+)(?:[.-](\d+))?\b/;
  const match = option.name.match(version) ?? value.match(version);
  return {
    family: family < 0 ? CLAUDE_FAMILIES.length : family,
    ...(match ? { version: [+match[1], +(match[2] ?? 0)] } : {}),
  };
}

/**
 * Claude models in the order of the Codex picker: newest version first, then
 * biggest first within a version. Unversioned (custom) models keep their
 * order at the end; an advertised Default stays first.
 */
export function orderClaudeModelOptions<
  T extends { value: string; name: string },
>(options: readonly T[]): T[] {
  const key = (option: T) =>
    option.value === "default"
      ? { first: true, family: 0 }
      : { first: false, ...claudeModelRank(option) };
  return options
    .map((option, index) => ({ option, index, rank: key(option) }))
    .sort((a, b) => {
      if (a.rank.first !== b.rank.first) return a.rank.first ? -1 : 1;
      const [av, bv] = [a.rank.version, b.rank.version];
      if (!av || !bv) return av ? -1 : bv ? 1 : a.index - b.index;
      return (
        bv[0] - av[0] ||
        bv[1] - av[1] ||
        a.rank.family - b.rank.family ||
        a.index - b.index
      );
    })
    .map(({ option }) => option);
}

/**
 * CoCalc's Claude model when the user has not chosen one: the newest Opus
 * advertised, a better daily driver than Claude Code's plan default. Without
 * an Opus the harness default stays.
 */
export function defaultClaudeModel(
  control: HarnessSelectControl,
): string | undefined {
  if (control.id !== "model") return undefined;
  return orderClaudeModelOptions(control.options).find(
    (option) =>
      option.value !== "default" &&
      CLAUDE_FAMILIES[claudeModelRank(option).family] === "opus",
  )?.value;
}

/**
 * Migrate saved Claude values the current adapter no longer advertises: the
 * old default sentinel, and a model saved with or without the 1M-context
 * suffix (e.g. `opus[1m]` from an older adapter that now offers `opus`).
 */
export function resolveClaudeConfigValue(
  control: HarnessSelectControl,
  value: string,
): string {
  const advertised = (candidate: string | undefined) =>
    candidate != null &&
    control.options.some((option) => option.value === candidate);
  if (advertised(value)) return value;
  if (value === "default" && ["model", "effort"].includes(control.id)) {
    const preferred = defaultClaudeModel(control) ?? control.recommendedValue;
    if (advertised(preferred)) return preferred!;
  }
  if (control.id === "model") {
    const alternate = value.endsWith(ONE_MILLION_CONTEXT)
      ? value.slice(0, -ONE_MILLION_CONTEXT.length)
      : `${value}${ONE_MILLION_CONTEXT}`;
    if (advertised(alternate)) return alternate;
  }
  return value;
}

export function parseHarnessSessionSettings(
  value: unknown,
): HarnessSessionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid ACP session settings");
  const obj = value as Record<string, unknown>;
  if (
    Object.keys(obj).some((key) => !["modeId", "configOptions"].includes(key))
  )
    throw Error("Unsupported ACP session setting");
  const result: HarnessSessionSettings = {};
  if (obj.modeId != null) result.modeId = text(obj.modeId);
  if (obj.configOptions != null) {
    result.configOptions = list(obj.configOptions, 32).map((option) => ({
      id: text(option?.id),
      value: text(option?.value),
    }));
    if (
      new Set(result.configOptions.map(({ id }) => id)).size !==
      result.configOptions.length
    )
      throw Error("Duplicate ACP session setting");
  }
  return result;
}

/** Shared chat metadata is advisory; validate again before building UI controls. */
export function parseHarnessSessionControls(
  value: unknown,
): HarnessSessionControls {
  const obj = value as HarnessSessionControls;
  if (!obj || typeof obj !== "object") throw Error("Invalid ACP controls");
  const configOptions = list(obj.configOptions, 32).map((control) => ({
    ...control,
    type: "select",
    _meta: {
      jetbrains: {
        air: { version: 1, recommendedValue: control.recommendedValue },
      },
    },
  }));
  const modes =
    obj.mode == null
      ? undefined
      : {
          currentModeId: obj.mode.currentValue,
          availableModes: list(obj.mode.options, 128).map((option) => ({
            id: option.value,
            name: option.name,
          })),
        };
  if (modes && configOptions.length) throw Error("Ambiguous ACP controls");
  return harnessSessionControls({
    configOptions: modes ? undefined : configOptions,
    modes,
  });
}
