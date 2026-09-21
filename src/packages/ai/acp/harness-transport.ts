import type { Readable, Writable } from "node:stream";
import { ReadableStream, WritableStream } from "node:stream/web";
import type { Stream } from "@agentclientprotocol/sdk-v1";

type Message = Stream extends { readable: globalThis.ReadableStream<infer T> }
  ? T
  : never;

export const ACP_MAX_FRAME_BYTES = 1024 * 1024;

/** Pull-based framing avoids the SDK's unbounded partial-line accumulator. */
export function harnessTransport(
  input: Readable,
  output: Writable,
  onFailure: (error: Error) => void,
): Stream {
  const iterator = input[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  let ended = false;
  const fail = (message: string) => {
    const error = Error(message);
    onFailure(error);
    return error;
  };
  return {
    readable: new ReadableStream<Message>({
      async pull(controller) {
        try {
          while (!ended) {
            const end = buffer.indexOf(10);
            if (end >= 0) {
              if (end > ACP_MAX_FRAME_BYTES)
                throw fail("ACP frame exceeds size limit");
              const line = buffer.subarray(0, end).toString("utf8");
              buffer = buffer.subarray(end + 1);
              if (!line.trim()) continue;
              let value: any;
              try {
                value = JSON.parse(line);
              } catch {
                throw fail("Malformed ACP JSON frame");
              }
              if (
                !value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                value.jsonrpc !== "2.0" ||
                !(typeof value.method === "string" || "id" in value)
              ) {
                throw fail("Invalid ACP JSON-RPC envelope");
              }
              controller.enqueue(value);
              return;
            }
            if (buffer.length > ACP_MAX_FRAME_BYTES)
              throw fail("ACP frame exceeds size limit");
            const next = await iterator.next();
            if (next.done) {
              ended = true;
              if (buffer.length) throw fail("Truncated ACP frame");
              controller.close();
              return;
            }
            const chunk = Buffer.from(next.value);
            // Node pipes have bounded reads. Reject oversized injected sources too.
            if (chunk.length > ACP_MAX_FRAME_BYTES)
              throw fail("ACP chunk exceeds size limit");
            buffer = Buffer.concat([buffer, chunk]);
          }
        } catch {
          ended = true;
          onFailure(Error("ACP input closed or invalid"));
          // Close cleanly: no SDK diagnostics containing a raw provider frame.
          controller.close();
        }
      },
      async cancel() {
        ended = true;
        input.destroy();
      },
    }) as Stream["readable"],
    writable: new WritableStream<Message>({
      async write(message) {
        const frame = JSON.stringify(message) + "\n";
        if (Buffer.byteLength(frame) > ACP_MAX_FRAME_BYTES)
          throw fail("Outgoing ACP frame exceeds size limit");
        await new Promise<void>((resolve, reject) => {
          output.write(frame, (error) => (error ? reject(error) : resolve()));
        });
      },
      close() {
        output.end();
      },
      abort() {
        output.destroy();
      },
    }) as Stream["writable"],
  };
}
