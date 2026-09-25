import type { OutputMessage } from "@cocalc/conat/project/jupyter/run-code";

export const OUTPUT_LIMIT_MIB_CHOICES = [1, 4, 16, 64] as const;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const MAX_OUTPUT_LIMIT_BYTES = 64 * DEFAULT_OUTPUT_LIMIT_BYTES;

export function outputLimitBytes(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_OUTPUT_LIMIT_BYTES)
    : DEFAULT_OUTPUT_LIMIT_BYTES;
}

const OUTPUT_TYPES = new Set([
  "stream",
  "display_data",
  "update_display_data",
  "execute_result",
  "error",
  "clear_output",
]);

// One instance per cell execution, before output conversion, replay or storage.
// This is a usability limit, not a limit on kernel memory or IOPub frame size.
export class OutputBudget {
  private remaining: number;
  private truncated = false;

  constructor(private readonly limit: number) {
    this.remaining = limit;
  }

  accept(mesg: OutputMessage): OutputMessage | undefined {
    if (!OUTPUT_TYPES.has(mesg.msg_type ?? "")) return mesg;
    if (this.truncated) return;

    // Avoid copying a potentially enormous stdout string just to measure it.
    const size =
      mesg.msg_type === "stream" && typeof mesg.content?.text === "string"
        ? Buffer.byteLength(mesg.content.text, "utf8") + 64
        : Buffer.byteLength(
            JSON.stringify({ content: mesg.content, metadata: mesg.metadata }),
            "utf8",
          );
    const bytes =
      size + (mesg.buffers ?? []).reduce((n, b) => n + b.byteLength, 0);
    if (bytes <= this.remaining) {
      this.remaining -= bytes;
      return mesg;
    }

    this.truncated = true;
    return {
      id: mesg.id,
      run_id: mesg.run_id,
      msg_type: "stream",
      output_truncated: true,
      content: {
        name: "stderr",
        text: `\nOutput truncated: this cell reached its ${this.limit} byte output limit. Further output is discarded, but the code keeps running. Use Run > Output limit to raise the limit before running again, or write large results to a file.\n`,
      },
    };
  }
}
