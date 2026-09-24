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
let selectedThinking = "low";
let selectedMode = "code";
const controls = () =>
  process.argv.includes("--config-options")
    ? {
        configOptions: [
          ...(process.argv.includes("--dependent-config")
            ? [
                {
                  id: "thinking",
                  name: "Thinking",
                  type: "select",
                  currentValue: selectedThinking,
                  options: [
                    { value: "low", name: "Low" },
                    { value: "high", name: "High" },
                  ],
                },
              ]
            : []),
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
    update(JSON.stringify(message.error ?? message.result));
    result(permissionPrompt, { stopReason: "end_turn" });
    return;
  }
  switch (message.method) {
    case "initialize":
      if (process.argv.includes("--hang")) return;
      return result(message.id, {
        protocolVersion: process.argv.includes("--wrong-version") ? 999 : 1,
        agentInfo: {
          name: process.argv.includes("--claude-adapter")
            ? "@agentclientprotocol/claude-agent-acp"
            : "cocalc-fixture",
          version: process.argv.includes("--claude-adapter") ? "0.81.1" : "1",
        },
        agentCapabilities: {
          loadSession: !process.argv.includes("--no-resume"),
        },
        ...(process.argv.includes("--steering")
          ? { _meta: { steering: { supported: true } } }
          : {}),
        authMethods: [],
      });
    case "session/new":
      if (process.argv.includes("--claude-adapter")) {
        const options = message.params._meta?.claudeCode?.options;
        if (
          !options ||
          !Array.isArray(options.tools) ||
          options.tools.length ||
          !Array.isArray(options.settingSources) ||
          options.settingSources.length ||
          message.params.mcpServers.length !== 1 ||
          message.params.mcpServers[0]?.name !== "cocalc_project" ||
          message.params.mcpServers[0]?.command !== "/opt/cocalc/bin/node" ||
          message.params.mcpServers[0]?.args?.[0] !==
            "/run/cocalc/agent-tools/bridge.cjs"
        )
          return send({
            id: message.id,
            error: { code: -32602, message: "subscription policy missing" },
          });
        if (process.argv.includes("--subscription-status"))
          send({
            method: "_auth/status_update",
            params: {
              authStatus: {
                kind: "account",
                label: "Claude Max",
                account: { plan: "max" },
              },
            },
          });
        if (process.argv.includes("--api-key-status"))
          send({
            method: "_auth/status_update",
            params: { authStatus: { kind: "api_key", label: "API key" } },
          });
      }
      return result(message.id, {
        sessionId: "fixture-session",
        ...controls(),
      });
    case "session/load":
      update("old replayed answer");
      if (process.argv.includes("--crash-resume")) return process.exit(2);
      if (process.argv.includes("--reject-resume"))
        return send({
          id: message.id,
          error: { code: -32603, message: "private fixture resume detail" },
        });
      return result(message.id, controls());
    case "session/set_config_option":
      if (process.argv.includes("--ignore-config"))
        return result(message.id, controls());
      if (
        process.argv.includes("--dependent-config") &&
        message.params.configId === "thinking"
      ) {
        selectedThinking = message.params.value;
        return result(message.id, controls());
      }
      if (
        message.params.configId !== "model" ||
        !["fast", "deep"].includes(message.params.value)
      )
        return result(message.id, {});
      selectedModel = message.params.value;
      if (process.argv.includes("--dependent-config")) selectedThinking = "low";
      return result(message.id, controls());
    case "session/set_mode":
      selectedMode = message.params.modeId;
      return result(message.id, {});
    case "session/prompt": {
      const rawText = message.params.prompt[0].text;
      const contextEnd = "[/CoCalc project context]\n\n";
      const contextualText = rawText.startsWith("[CoCalc project context]\n")
        ? rawText.slice(rawText.indexOf(contextEnd) + contextEnd.length)
        : rawText;
      const text = contextualText.replace(
        /^System note: this message was queued for [^\n]+ while another turn was active, and is being sent automatically now\.\n\n/,
        "",
      );
      if (text === "images") {
        update(
          JSON.stringify(
            message.params.prompt.slice(1).map(({ type, mimeType, data }) => ({
              type,
              mimeType,
              bytes: Buffer.from(data ?? "", "base64").length,
            })),
          ),
        );
        return result(message.id, { stopReason: "end_turn" });
      }
      if (text === "turn-context") {
        const contextLine = rawText
          .split("\n")
          .find((line) => line.startsWith('{"project_id":'));
        update(contextLine ?? "No publication context");
        return result(message.id, { stopReason: "end_turn" });
      }
      if (text === "heap-exhaustion") {
        const { getHeapStatistics } = require("node:v8");
        if (getHeapStatistics().heap_size_limit > 96 * 1024 * 1024) {
          return send({
            id: message.id,
            error: {
              code: -32603,
              message: "Set a small Node heap limit first",
            },
          });
        }
        update("working before heap exhaustion");
        // Yield so the protocol output reaches the client before V8 aborts.
        return setTimeout(() => {
          const allocations = [];
          for (let i = 0; i < 128; i++)
            allocations.push(new Array(256 * 1024).fill(i));
          process.exit(3);
        }, 50);
      }
      if (
        [
          "question",
          "question-wrong-session",
          "question-optional",
          "question-pattern",
          "question-boolean",
        ].includes(text)
      ) {
        questionPrompt = message.id;
        pendingPrompt = message.id;
        return send({
          id: "question",
          method: "elicitation/create",
          params: {
            mode: "form",
            sessionId:
              text === "question-wrong-session" ? "wrong" : "fixture-session",
            message: "Choose the target.",
            requestedSchema: {
              type: "object",
              required: text === "question-optional" ? [] : ["target"],
              properties: {
                target: {
                  type: text === "question-boolean" ? "boolean" : "string",
                  title: "Target",
                  ...(text === "question-boolean"
                    ? {}
                    : { enum: ["local", "staging"] }),
                  ...(text === "question-pattern"
                    ? { pattern: "^local$" }
                    : {}),
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
      const unsupportedCallbacks = {
        "unsupported-terminal": ["terminal/create", { command: "echo" }],
        "unsupported-terminal-output": [
          "terminal/output",
          { terminalId: "missing" },
        ],
        "unsupported-terminal-release": [
          "terminal/release",
          { terminalId: "missing" },
        ],
        "unsupported-terminal-wait": [
          "terminal/wait_for_exit",
          { terminalId: "missing" },
        ],
        "unsupported-terminal-kill": [
          "terminal/kill",
          { terminalId: "missing" },
        ],
        "unsupported-file-read": [
          "fs/read_text_file",
          { path: "/not-a-real-file" },
        ],
        "unsupported-file-write": [
          "fs/write_text_file",
          { path: "/not-a-real-file", content: "test" },
        ],
      };
      if (unsupportedCallbacks[text]) {
        permissionPrompt = message.id;
        const [method, params] = unsupportedCallbacks[text];
        return send({
          id: "permission",
          method,
          params: { sessionId: "fixture-session", ...params },
        });
      }
      if (text.startsWith("permission")) {
        permissionPrompt = message.id;
        return send({
          id: "permission",
          method: "session/request_permission",
          params: {
            sessionId:
              text === "permission-wrong-session"
                ? "other-session"
                : "fixture-session",
            toolCall: {
              toolCallId: "write-1",
              title: "Edit project file",
              status: "pending",
            },
            options:
              text === "permission-deny-only"
                ? [{ optionId: "deny", kind: "reject_once", name: "Deny" }]
                : text === "permission-persistent-only"
                  ? [
                      {
                        optionId: "always",
                        kind: "allow_always",
                        name: "Always",
                      },
                    ]
                  : [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
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
    case "_session/steering":
      if (!process.argv.includes("--steering"))
        return send({
          id: message.id,
          error: { code: -32601, message: "Unsupported method" },
        });
      if (pendingPrompt == null)
        return result(message.id, {
          outcome: "promptRequired",
          reason: "noRunningTurn",
        });
      result(message.id, { outcome: "injected" });
      update(`steered: ${message.params.prompt[0].text}`);
      result(pendingPrompt, { stopReason: "end_turn" });
      pendingPrompt = undefined;
      return;
    default:
      if (message.id != null)
        send({
          id: message.id,
          error: { code: -32601, message: "Unsupported method" },
        });
  }
});
