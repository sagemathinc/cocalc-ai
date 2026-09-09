# Codex 0.153.4 TCP timeout restoration

## Scope and source

Local Linux x86_64 validation, September 8, 2026 (Pacific time).
Production was not changed. The CoCalc build script and versioned patch, not
the GitHub asset repository, define the patched build.

- Upstream tag: `rust-v0.153.4`.
- Source commit: `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`.
- Patch: `src/scripts/patches/codex-rust-v0.153.4-tcp-user-timeout.patch`.
- Patch SHA256: `3819839f908e55733d0dfc4404643efb1c7f37c68b9a6f1ad7bb2ed08598d0cf`.
- This is the unchanged 0.147.0 transport patch, which applies cleanly to 0.153.4.
- Rust 1.95.0; release build, LTO off, 16 codegen units, four build jobs.
- Both `codex-cli` and `codex-code-mode-host` built successfully.
- Cargo metadata changed only workspace lockfile versions from 0.0.0 to
  0.153.4; no external dependency versions changed.

The build needed OpenSSL and other native development packages. After those
were installed, the existing compilation was resumed with the same source,
V8 artifacts, and Cargo flags. The resumed release build took 24m35s.

## Controlled image-generation trials

All trials used app-server stdio, existing local authentication, new threads,
the same detailed CoCalc spectrum/workbench mockup prompt, and instructions
to make exactly one built-in imagegen call with no fallback or retries.
Times below measure imageGeneration started to completed, not the whole turn.

| Binary              | Model       | TCP user timeout             | Result                                     |
| ------------------- | ----------- | ---------------------------- | ------------------------------------------ |
| Official 0.153.4    | gpt-5.5     | Stock default                | Failed after 156.3s; tool reported timeout |
| Patched 0.153.4     | gpt-5.5     | 300000 ms                    | Valid PNG after 36.0s; turn completed      |
| Same patched binary | gpt-5.5     | 30000 ms override            | Failed after 155.9s                        |
| Same patched binary | gpt-6-astra | Patched default, no override | Valid PNG after 42.2s; turn completed      |

The failed counter-test was stopped after its terminal image failure event;
it was not allowed to spend additional time generating a textual response.
The successful gpt-5.5 tool arguments were inspected and matched the exact
prompt rather than a shortened rewrite.

`strace -f -e trace=setsockopt` confirmed successful TCP_USER_TIMEOUT settings
of 300000 in the successful patched trials and 30000 in the counter-test.
Only socket options were traced, not HTTP bodies or authentication headers.
Some unrelated sockets still use 30000: this patch affects clients constructed
through the patched shared default-client builder, not every client in Codex.

The locked reqwest 0.13.4 source defaults Linux TCP_USER_TIMEOUT to 30000 ms.
This is a socket-level timeout, not a total HTTP request deadline or CoCalc
app-server notification timeout. The same-binary counter-test strongly
implicates this setting in the observed failures. It does not establish the
precise network mechanism, a universal Google Cloud defect, or the cause of
every upstream imagegen report. No network capture was taken to establish
packet loss, keepalive behavior, or a particular intermediary's behavior.

## Local artifacts and evidence

- Candidate: `/tmp/codex/cocalc-0.153.4/bin/codex`.
- Companion: `/tmp/codex/cocalc-0.153.4/bin/codex-code-mode-host`.
- Codex SHA256: `b6606ff9f7ceb810ce4ee16730bd38ddc0f435c395faceeb461cdbdd50b08926`.
- Companion SHA256: `28b9b3f32be941bc3ff55a5f47ef69347624dda59f4d8fe5614e6623830ad7f9`.
- Separate source checkout: `/tmp/codex/build-0.153.4`.
- Build log: `/tmp/codex/build-0.153.4.log`.
- Harness: `/tmp/codex/compare-imagegen.cjs`.
- Trial logs: `/tmp/codex/{stock-1534,patched-300s,patched-30s,patched-astra-default}.jsonl`.
- Socket traces: corresponding `.sockets` files for the patched trials.

Successful sessions:

- gpt-5.5: `01a083ea-87f7-7bc2-88d2-a6b2331807c0`.
- Astra: `01a083ee-533e-71a2-8091-040afc4adcb7`.

## Release gates still outstanding

1. Build the ARM64 counterpart and assemble complete artifact provenance and
   checksums. Do not publish an incomplete two-architecture release.
2. Validate runtime library compatibility in the actual supported host images.
   This local binary is dynamically linked; its highest referenced GLIBC
   version is 2.39 and its OpenSSL symbol version is OPENSSL_3.0.0.
3. Exercise normal turns, tools, goals, cancellation, and remote compaction on
   staging with the matched CLI/code-mode-host pair. Imagegen passing does not
   validate all other behavior.
4. Publish the reviewed artifacts, update the sandbox installer URLs and
   pinned checksums, test installation on both architectures, then canary.
5. Only then roll out to production, preserving existing active worker turns.

For an upstream report, describe the measured same-version timeout comparison
and the patch. Do not claim all Linux/GCP traffic is broken or that the precise
network failure mechanism has been proven.
