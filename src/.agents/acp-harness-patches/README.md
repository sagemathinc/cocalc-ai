# Experimental Pi Provider-Error Patch

This is an operator qualification patch, not a vendored dependency or an
automatic installation step. Existing agent profiles and installed npm packages
are unchanged. Do not advertise an upstream fix or a released bridge version.

Base: `https://github.com/svkozak/pi-acp`, tag `v0.0.33`, commit
`1bfcb394088ed879db8fd936b570bb626017f878`. License: MIT; see `pi-acp-LICENSE`.
Patch: `pi-acp-0.0.33-provider-error.patch`.

The bridge ignored assistant stop status in `turn_end` and resolved settled
prompts as successful. The patch remembers the last assistant's error status
until `agent_settled`, then rejects with a generic ACP internal error. Successful
retries overwrite the error status; cancellation remains cancellation; new
prompts reset the status. It does not forward raw provider error bodies or add
provider-specific inference rules to CoCalc. Three regression cases cover those
state transitions and next-prompt reset.

## Reproduce

In a separate checkout of that exact upstream commit:

```sh
git apply --check /absolute/path/to/pi-acp-0.0.33-provider-error.patch
git apply /absolute/path/to/pi-acp-0.0.33-provider-error.patch
npm ci --ignore-scripts
npm test
npm run typecheck
npx eslint src/acp/session.ts test/component/session-events.test.ts
npm run build
```

Then run CoCalc's bundled `harness-provider-smoke.ts` against a separate installed
executable with `pi --provider-reject`, and without `--provider-reject`. Preserve
the package directory, license and dependencies, and give experimental packaging
an explicit local version rather than claiming the unmodified upstream release.
Do not overwrite real provider configuration or an existing installation.

## Observed Results

2026-09-21: 98 upstream tests, typecheck, focused lint and build passed. The
patched bundle passed local HTTP 401 propagation (one fake-provider request)
and normal file-write/follow-up smoke (three local requests) with Pi `0.86.1`.
No paid inference was used. These are standalone real-harness/client probes,
not durable/browser or offline qualification of this modified bridge.

The subsequent `--provider-retry` probe also passes: one HTTP 503 on task
inference triggers visible Pi retry/resume progress, followed by verified file
creation and a successful same-session follow-up (four total local requests).
This verifies recovery from one transient provider failure, not all retry or
compaction cases, and does not enable CoCalc-side uncertain-turn resubmission.

Bundle SHA-256:
`747673313e7db7057105e26012c86dc0809960c234e556a34e395cf721d98789`.
Patch SHA-256:
`803458440ca961216e88bb09de7e350218cb59105c5fe0bc1845aa0107f1efea`.
The first loose-file probe reported fallback version `0.0.0`; packaging it
separately with version `0.0.33-cocalc-provider-error-probe.1` fixed attribution,
and HTTP 401 qualification passed again with that reported version.

Disposable executable:
`/home/user/acp-qualification/node_modules/.bin/pi-acp-provider-error-probe`
in project `1892b11a-6c63-4a92-988d-01dcddc0bc79`. The upstream checkout remains
uncommitted at `/tmp/cocalc-pi-acp-033-error-probe`; no upstream PR was submitted.
Broader provider errors, retry/compaction behavior, dependency audit and release
review remain outside this qualification. Prefer a reviewed upstream release
when one is available, then rerun both probes rather than silently retaining
this patch.
