// Deterministic stdio harness: no model, credentials or network calls.
const readline = require("node:readline");
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const result = (id, value) => send({ id, result: value });
let pendingPrompt;
let permissionPrompt;
let questionPrompt;
let counter = 0;
let selectedModel = "fast";
let selectedMode = "code";
const controls = () =>
  process.argv.includes("--config-options")
    ? {
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: selectedModel,
            options: [
              {
                group: "fixture",
                name: "Fixture",
                options: [
                  { value: "fast", name: "Fast" },
                  { value: "deep", name: "Deep" },
                ],
              },
            ],
          },
        ],
      }
    : process.argv.includes("--modes")
      ? {
          modes: {
            currentModeId: selectedMode,
            availableModes: [
              { id: "code", name: "Code" },
              { id: "plan", name: "Plan" },
            ],
          },
        }
      : {};
const update = (text, sessionId = "fixture-session") =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === "question") {
    if (questionPrompt == null) return;
    update(JSON.stringify(message.result ?? { rejected: true }));
    result(questionPrompt, { stopReason: "end_turn" });
    questionPrompt = undefined;
    pendingPrompt = undefined;
    return;
  }
  if (message.id === "permission") {
    update(JSON.stringify(message.result));
    result(permissionPrompt, { stopReason: "end_turn" });
    return;
  }
  switch (message.method) {
    case "initialize":
      if (process.argv.includes("--hang")) return;
      return result(message.id, {
        protocolVersion: process.argv.includes("--wrong-version") ? 999 : 1,
        agentInfo: { name: "cocalc-fixture", version: "1" },
        agentCapabilities: {
          loadSession: !process.argv.includes("--no-resume"),
        },
        authMethods: [],
      });
    case "session/new":
      return result(message.id, {
        sessionId: "fixture-session",
        ...controls(),
      });
    case "session/load":
      update("old replayed answer");
      return result(message.id, controls());
    case "session/set_config_option":
      if (
        message.params.configId !== "model" ||
        !["fast", "deep"].includes(message.params.value)
      )
        return result(message.id, {});
      selectedModel = message.params.value;
      return result(message.id, controls());
    case "session/set_mode":
      selectedMode = message.params.modeId;
      return result(message.id, {});
    case "session/prompt": {
      const rawText = message.params.prompt[0].text;
      const contextEnd = "[/CoCalc project context]\n\n";
      const text = rawText.startsWith("[CoCalc project context]\n")
        ? rawText.slice(rawText.indexOf(contextEnd) + contextEnd.length)
        : rawText;
      if (text === "turn-context") {
        const contextLine = rawText
          .split("\n")
          .find((line) => line.startsWith('{"project_id":'));
        update(contextLine ?? "No publication context");
        return result(message.id, { stopReason: "end_turn" });
      }
      if (text === "question" || text === "question-wrong-session") {
        questionPrompt = message.id;
        pendingPrompt = message.id;
        return send({
          id: "question",
          method: "elicitation/create",
          params: {
            mode: "form",
            sessionId: text === "question" ? "fixture-session" : "wrong",
            message: "Choose the target.",
            requestedSchema: {
              type: "object",
              required: ["target"],
              properties: {
                target: {
                  type: "string",
                  title: "Target",
                  enum: ["local", "staging"],
                },
              },
            },
          },
        });
      }
      if (text === "tools") {
        for (const tool of [
          {
            sessionUpdate: "tool_call",
            toolCallId: "inspect",
            title: "Inspect fixture",
            status: "in_progress",
            kind: "read",
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "inspect",
            status: "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Fixture tool output verified.",
                },
              },
            ],
          },
        ])
          send({
            method: "session/update",
            params: { sessionId: "fixture-session", update: tool },
          });
        update("Tool activity completed.");
        return result(message.id, { stopReason: "end_turn" });
      }
      if (text === "settings") {
        update(`${selectedModel}/${selectedMode}`);
        return result(message.id, { stopReason: "end_turn" });
      }
      const stopped =
        /^stop:(max_tokens|max_turn_requests|refusal)(:partial)?$/.exec(text);
      if (stopped) {
        if (stopped[2]) update("Partial output before stopping.");
        return result(message.id, { stopReason: stopped[1] });
      }
      if (text === "quiet" || text === "quiet-long") {
        pendingPrompt = message.id;
        setTimeout(
          () => {
            if (pendingPrompt !== message.id) return;
            pendingPrompt = undefined;
            update("Quiet turn completed.");
            result(message.id, { stopReason: "end_turn" });
          },
          text === "quiet-long" ? 35000 : 3200,
        );
        return;
      }
      if (text === "stderr-flood") {
        const diagnostic = "private diagnostic ".padEnd(65536, "x");
        let remaining = 128;
        const write = () => {
          if (remaining-- > 0) return process.stderr.write(diagnostic, write);
          update("Diagnostics drained.");
          result(message.id, { stopReason: "end_turn" });
        };
        write();
        return;
      }
      if (text === "flood") {
        for (let i = 0; i < 100; i++) update("x".repeat(65536));
        return;
      }
      if (text === "crash") return process.exit(2);
      if (text === "malformed")
        return process.stdout.write("secret-not-json\n");
      if (text === "oversized")
        return process.stdout.write("x".repeat(1024 * 1024 + 10));
      if (text === "truncated") {
        process.stdout.write('{"jsonrpc":');
        return process.exit(0);
      }
      if (text === "reject")
        return send({
          id: message.id,
          error: { code: -32000, message: "secret rejection details" },
        });
      if (text === "wrong-session") {
        update("wrong", "another-session");
        return;
      }
      if (text === "hang") {
        pendingPrompt = message.id;
        update("working");
        return;
      }
      if (text === "permission") {
        permissionPrompt = message.id;
        return send({
          id: "permission",
          method: "session/request_permission",
          params: {
            sessionId: "fixture-session",
            toolCall: {
              toolCallId: "write-1",
              title: "Edit project file",
              status: "pending",
            },
            options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
          },
        });
      }
      process.stderr.write("diagnostic secret must never become an event\n");
      update("Hello ");
      update(`world ${++counter}`);
      return result(message.id, { stopReason: "end_turn" });
    }
    case "session/cancel":
      if (process.argv.includes("--ignore-cancel")) return;
      if (pendingPrompt != null) {
        questionPrompt = undefined;
        result(pendingPrompt, {
          stopReason: process.argv.includes("--cancel-as-completed")
            ? "end_turn"
            : "cancelled",
        });
        pendingPrompt = undefined;
      }
      return;
    default:
      if (message.id != null)
        send({
          id: message.id,
          error: { code: -32601, message: "Unsupported method" },
        });
  }
});
