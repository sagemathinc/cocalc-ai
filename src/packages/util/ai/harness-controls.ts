/** Bounded display metadata, not launch configuration or an authorization grant. */
export interface HarnessSelectControl {
  id: string;
  name: string;
  currentValue: string;
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

/** Strip descriptions/extensions and cap the catalog before persisting or rendering. */
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
      return [
        {
          id: text(option.id),
          name: text(option.name),
          currentValue: text(option.currentValue),
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
  if (JSON.stringify(result).length > 256 * 1024)
    throw Error("ACP control catalog too large");
  return result;
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
