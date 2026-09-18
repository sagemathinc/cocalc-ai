# Live Lost-Acknowledgment Probe

This opt-in QA adapter calls the built production CLI send helper with the
source turn's own scoped credential. It discards one matching accepted response
at the CLI transport boundary. It does not change server code or simulate a
network outage. A real, authorized message is sent.

Build the CLI first. Run ncc outside the workspace so TypeScript path aliases do
not replace compiled runtime dependencies with source modules:

```sh
pnpm -C src/packages/cli build
node --test src/packages/cli/sea/agent-messaging-lost-ack.test.cjs
CLI_ROOT="$(pwd)/src/packages/cli"
(cd /tmp && /opt/cocalc/bin/node "$CLI_ROOT/node_modules/@vercel/ncc/dist/ncc/cli.js" \
  build "$CLI_ROOT/sea/agent-messaging-lost-ack.cjs" \
  -o "$CLI_ROOT/build/lost-ack-qa" --minify)
```

Upload the resulting `index.cjs` to a disposable source project through the
normal authorized file API. Create an explicit Agent Session containing the
source and intended QA receiver. Do not revive unrelated closed sessions or
copy a human credential into the source turn.

Ask the actual source agent to execute this command exactly once, using its
existing runtime environment:

```text
/opt/cocalc/bin/node <uploaded-index.cjs> <source-agent-uuid> <agent-session-uuid> <target-project-uuid> <target-agent-uuid> <new-attempt-uuid> <new-evidence-file>
```

The agent should report stdout and stop, without inspecting the evidence file,
renewing permission, or retrying. The receiver gets a bounded request to
acknowledge locally only, not to reply or execute commands. The harness reserves
the evidence path before sending, so repeating the same invocation fails before
network access. Do not change that path to retry a completed test.

Verify independently:

- The source's persisted activity contains one command and reports `unknown`.
- The evidence file records one exact `accepted-ack-discarded`, followed by
  `sender-outcome` with `sends: 1` and `dropped: true`.
- The receiver contains the matching attempt and authenticated attribution.
  Check execution separately; acceptance does not prove completion.
- No new proposal or follow-up send appeared. Close the QA session after
  observation; do not interrupt admitted work just to clean up the session.

Exit 0 means the intended accepted-to-unknown transformation was observed.
Exit 2 means the probe ran but that condition was not met (for example, the
server rejected the send). A rejected response is not deliberately discarded.
Exit 1 is a setup/runtime error. None of these exit codes authorizes a retry.
Evidence contains attempt IDs and outcomes, not credentials or message bodies.
