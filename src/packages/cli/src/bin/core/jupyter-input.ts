import type {
  JupyterInputPrompt,
  JupyterInputRequest,
} from "@cocalc/conat/project/jupyter/run-input";
import type { JupyterClient } from "@cocalc/conat/project/jupyter/run-code";

type Pending = {
  prompt: JupyterInputRequest;
  promise?: Promise<string>;
  answer?: string;
  failure?: Error;
  acknowledged: boolean;
};

export function createJupyterInputResponder(
  callback: (prompt: JupyterInputPrompt) => Promise<string>,
) {
  let current: Pending | undefined;
  let closed = false;
  const handle = (
    prompt: JupyterInputPrompt & Partial<JupyterInputRequest>,
  ): Promise<string> => {
    if (closed) return Promise.reject(Error("Jupyter input responder closed"));
    // Older services do not expose recoverable request identities.
    if (prompt.request_id == null) return callback(prompt);
    if (
      !Number.isSafeInteger(prompt.sequence) ||
      prompt.sequence! <= 0 ||
      !Number.isFinite(prompt.expires_at) ||
      prompt.expires_at! <= Date.now()
    )
      return Promise.reject(Error("Invalid or expired Jupyter input request"));
    if (current && prompt.sequence! <= current.prompt.sequence) {
      if (
        prompt.sequence !== current.prompt.sequence ||
        prompt.request_id !== current.prompt.request_id ||
        current.acknowledged
      )
        return Promise.reject(Error("Stale Jupyter input request"));
      return current.promise!;
    }
    const entry: Pending = {
      prompt: prompt as JupyterInputRequest,
      acknowledged: false,
    };
    current = entry;
    entry.promise = Promise.resolve()
      .then(() => {
        if (closed || current !== entry || entry.acknowledged)
          throw Error("Jupyter input request no longer active");
        return callback(prompt);
      })
      .then(
        (answer) => {
          if (
            closed ||
            current !== entry ||
            entry.acknowledged ||
            Date.now() >= entry.prompt.expires_at
          )
            throw Error("Jupyter input request no longer active");
          entry.answer = answer;
          return answer;
        },
        () => {
          throw Error("Jupyter input callback failed");
        },
      );
    void entry.promise.catch(() => {
      if (!closed && current === entry && !entry.acknowledged)
        entry.failure = Error("Jupyter input callback failed");
    });
    return entry.promise;
  };
  return {
    handle,
    close: () => {
      closed = true;
      current = undefined;
    },
    recover: async (
      client: Pick<JupyterClient, "getInput" | "answerInput">,
      runId: string,
      remainingMs: () => number,
    ) => {
      const prompt = await client.getInput(runId, { timeout: remainingMs() });
      if (closed) return;
      if (!prompt) {
        if (current) {
          current.acknowledged = true;
          current.answer = undefined;
          current.promise = undefined;
        }
        return;
      }
      void handle(prompt).catch(() => undefined);
      const entry = current;
      if (!entry || entry.prompt.request_id !== prompt.request_id)
        throw Error("Jupyter input request mismatch");
      if (entry.failure) throw entry.failure;
      if (entry.answer === undefined || entry.acknowledged) return;
      await client.answerInput(runId, prompt.request_id, entry.answer, {
        timeout: remainingMs(),
      });
      if (current === entry) {
        entry.acknowledged = true;
        entry.answer = undefined;
        entry.promise = undefined;
      }
    },
  };
}
