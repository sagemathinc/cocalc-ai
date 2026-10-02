import { OUTPUT_LIMIT_MIB_CHOICES } from "@cocalc/jupyter/execute/output-budget";

export function outputLimitMenu(actions?: {
  get_output_limit_bytes(): number;
  set_output_limit_bytes(bytes: number): void;
  isClosed?(): boolean;
}) {
  const available = () => actions != null && !actions.isClosed?.();
  const selectedLimit = available()
    ? actions?.get_output_limit_bytes()
    : undefined;
  return OUTPUT_LIMIT_MIB_CHOICES.map((mib) => ({
    name: `output-limit-${mib}`,
    label: `${mib} MiB${mib === 1 ? " (default)" : ""}${
      selectedLimit === mib * 1024 * 1024 ? " (selected)" : ""
    }`,
    disabled: ({ readOnly }: { readOnly: boolean }) => readOnly || !available(),
    onClick: () => {
      if (available()) actions?.set_output_limit_bytes(mib * 1024 * 1024);
    },
  }));
}
