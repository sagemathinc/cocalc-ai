# CoCalc CLI distribution: pinned Node + JS bundle, served by the hub

Status: revision 2 (Oct 12, 2026). Rev 1 (7e17dbc41f) got a REQUEST CHANGES security review from @lite1-review (8 high, 5 medium). This revision answers every point; the numbers in brackets, e.g. [R2], refer to that review. William reviews after @lite1-review approves.

## Why change

What went wrong on Oct 12 while testing the one-line setup (`curl … | sh`):

- **The installer drifted.** `software.cocalc.ai/software/cocalc/install.sh` predates the bash 3.2 fix that has been in the repo since Sep 29 (e423f383c3), so macOS `/bin/bash` fails with `runtime_env[@]: unbound variable`.
- **The CLI drifted.** The `latest` channel is from July and has no `computer` command. No hub says which CLI goes with it.
- **Releases are heavy, so they are rare.** Each release builds a Node SEA per platform (48 MB gzipped, 147 MB on disk). The macOS build is signed and notarized on a Mac runner, and the Windows build is signed with Microsoft Artifact Signing.
- **Skew fails obscurely.** One CLI talks to many sites at different versions, and a missing feature shows up as "unknown command" deep inside a step.
- **Today's updates aren't really verified.** The installer checks a sha256 that comes from the same server as the bytes. Nothing would detect a compromised `software.cocalc.ai`. This design is a strict improvement over that.

## Facts this design relies on

- **The CLI is one JavaScript file:** `cocalc-cli.js`, 6.3 MB, 1.65 MB gzipped. It uses only Node built-ins (including `node:sqlite`, Node 22.5+) with no native addons, and projects already run it as `node cocalc-cli.js`.
- **Every hub build already contains that bundle.**
- **Official Node builds are already signed** (26–32 MB per platform): notarized for macOS and Authenticode-signed for Windows by the Node project, with `SHASUMS256.txt` signed by the Node release keys.
- **`tuf-js` exists**, the Update Framework client that npm's sigstore uses. It's pure JavaScript, so a TUF client can run on the pinned Node.

## Scope and phases

- **Phase 1 (this design):** Linux and macOS. A signed release channel (stable by default, candidate and dev by opt-in), hub-served installer and pointers, the launcher, updates, the skew check, and a separate computers release.
- **Later:** Windows (its own launcher, see below). Until then Windows keeps the signed SEA.
- **Deferred until site and role binding is designed:** per-site bundles, where the CLI runs each site's own build [R6]. Nothing below depends on them.

## Threat model

| Threat | In scope? | Outcome with this design |
|---|---|---|
| Network attacker (MITM) | yes | Stopped. HTTPS for transport, plus signed metadata for everything after bootstrap. |
| Compromised CDN, R2 or mirror **after** a trusted bootstrap | yes | Can only deny service or delay. All content must match signed TUF metadata, and expiring timestamp metadata bounds freeze or replay. |
| Compromised CDN or site **at first install, or on any `curl \| sh` re-run** | **no** (stated honestly) [R1] | Full code execution as the user. `curl \| sh` trusts the origin that finally serves the script, and its CDN, completely. This is the same for every `curl \| sh`. Mitigations: below. |
| Malicious or compromised site after install | yes | Can't push code. A site only names a target that already exists in the signed channel metadata the client trusts. |
| Compromised CI or build pipeline | yes, contained | Can't sign: signing is a separate minimal job with a non-exportable KMS key [R2]. A malicious *commit* that passes review is out of scope, just as for any release process. |
| Compromised online signing key (timestamp/snapshot) | yes | Bounded by short expiry. Rotated by targets or root; can't create new targets. |
| Compromised targets key (e.g. `cli-stable`) | yes | Can sign bad releases until root revokes the delegation. Recovery is defined below. |
| Compromised root keys (threshold) | no | Offline hardware, threshold. Out of scope beyond holding them carefully. |
| Compromised upstream Node | yes | Release-time verification of Node's signed `SHASUMS256` against pinned Node release keys [R8]. |
| Insider or targeted equivocation (a different signed release for one victim) | partly | Every signed target is published in snapshot metadata. Clients pin the snapshot version, so a hidden one-off release must sit in public metadata. Transparency logging could come later. |
| Freeze or replay (serving old metadata) | yes | TUF timestamp expiry. Clients refuse expired metadata unless a local offline policy explicitly allows it [R7]. |
| Disk, stream or memory exhaustion | yes | Size caps on metadata and downloads, timeouts, and unpacked-size and file-count limits [R8]. |
| Partial, crashed or concurrent updates | yes | A transaction with a lock and atomic pointer swap, plus crash recovery [R9]. |
| Environment injection (`NODE_OPTIONS`, `NODE_PATH`, proxy, custom CA) | partly | The launcher clears `NODE_OPTIONS` and `NODE_PATH` [R10]. A proxy or custom CA can't forge signed metadata, so it only affects availability. |
| Same-user or local-admin compromise | **no** | Anything running as you can rewrite your files. That includes an unsigned dev bundle you opted into [R4] and direct-mode computer jobs [R5]. |

**Reducing first-install trust [R1].**
- `install.sh` is small and readable. Docs publish its sha256 per release, for people who want to check it before running it.
- If a verified launcher is already installed, the setup line calls `cocalc update` (signature-verified) instead of piping a new installer, so a re-run doesn't re-trust the site.
- Anyone who needs a CDN-proof first install can use an out-of-band path: a package manager, or the signed SEA, until that is retired.

## Signing: TUF roles [R2, R3, R6, R7]

We use TUF's metadata format and semantics through `tuf-js`, rather than inventing our own. TUF provides the following:
- canonical JSON;
- the exact bytes that are signed;
- key IDs, with the algorithm fixed per key in root (Ed25519 only);
- signature thresholds;
- version and expiry fields;
- strict size limits.

Our own policy layer on top of that:
- **schemas:** unknown fields and duplicate keys are rejected;
- **caps:** metadata at most 1 MB, and integers bounded.

| Role | Signs | Key and custody | Expiry |
|---|---|---|---|
| `root` | the keys and thresholds of every role | offline hardware keys, **2 of 3** (William plus two others) | 1 year; rotated by threshold |
| `targets` (top level) | delegations to the roles below | offline, 2 of 3 | 6 months |
| `cli-stable` | stable CLI releases (bundle, Node, bootstrap) | KMS, non-exportable; used only by the release signing job, after a manual approval | 3 months |
| `cli-candidate`, `cli-dev` | candidate and dev releases | KMS (separate keys); signed automatically per main commit | 1 month |
| `computers` | computer daemon releases (decision 27) | **offline**, separate from all CLI keys | 6 months |
| `snapshot`, `timestamp` | which metadata versions are current, and freshness | KMS, online | snapshot 7 days, timestamp 1 day |

- **CI isolation [R2].**
  - The build job produces the bundle and a provenance attestation and never sees a signing key.
  - A separate signing job, a few dozen lines in its own workflow, does no checkout and runs no repository code. It receives the artifact digest and size, checks the attestation, gets KMS access through GitHub OIDC (no exportable secret), and signs the metadata.
  - Stable signing needs a protected environment with manual approval.
- **Channels are roles [R6].** A stable client trusts only `cli-stable` targets. Candidate and dev need an explicit local opt-in (`cocalc update --channel candidate`), and highest-seen state is tracked per role. A dev build can't raise a stable client's floor.
- **Revocation and recovery [R2, R7].**
  - *A bad signed release:* the role signs metadata that removes the target, and lists it as revoked in a custom field the client honors. Clients on it are told to update or roll back.
  - *A compromised delegated key:* the threshold of `targets` and `root` rotates the delegation. Old signatures stop verifying after the next root or targets version.
  - *A compromised online key:* rotated the same way, with exposure bounded by expiry.
  - *Lost root keys:* a threshold means one lost key isn't fatal. Losing two needs a manual re-bootstrap announced out of band.

## What every hub serves

Unauthenticated GETs, all bytes only; trust comes from TUF metadata, never from the site:

| Path | What |
|---|---|
| `/cli/install.sh` | the installer, built with this hub. It embeds the root metadata, plus the expected sha256 and size of the bootstrap verifier and Node archive for each platform [R1] |
| `/cli/tuf/<role>.json`, `/cli/tuf/<version>.root.json` | a mirror of the TUF metadata (bytes only; signatures decide) |
| `/cli/targets/<sha256>.<ext>` | bundles, bootstrap verifiers, Node archives, content-addressed (`immutable`, edge-cached) |
| `/cli/site.json` | **unsigned hint**: this hub's minimum supported CLI version and the target it recommends. The client uses it only to pick among targets it already trusts, so the hint can't add code |

- **Redirects [R6]:** the client never follows a cross-origin redirect for metadata. Mirrors for target bytes must appear in signed metadata (a custom `mirrors` list in `targets`).
- **The source of truth:** official metadata lives at `software.cocalc.ai` and in R2. Hubs and Star sites mirror it; a hub has no signing authority.

## Install (first time) [R1, R8, R10]

`curl -fsSL <site>/cli/install.sh | sh` runs these steps under `umask 077`:

1. **Pick the platform.** Detect OS and arch. Refuse unsupported ones and symlinked install directories.
2. **Fetch and check Node.** Download the pinned Node archive (content-addressed, size-capped, with a timeout). Check its size and sha256 against the values embedded in `install.sh`, using `sha256sum` or `shasum -a 256`, before extracting.
3. **Extract safely** into private staging with these checks:
   - no absolute paths, `..`, or links leaving the tree;
   - caps on file count and unpacked size.

   Then rename into `node/<sha256>/`.
4. **Fetch the bootstrap verifier.** This is `bootstrap.js`: `tuf-js` plus our policy, a small fixed program. Download it and check it against the embedded sha256.
5. **Verify a release.** Run the verifier with the pinned Node and a cleared environment. It initializes TUF from the embedded root, fetches the timestamp, snapshot and targets metadata, and verifies the stable release target: bundle, Node and bootstrap hashes. That target must match what was embedded, or else it must be a newer, signed one.
6. **Commit.** Download and verify the bundle, write the active-release record, and install the launcher (all of it in the transaction below).

From then on, everything goes through the bootstrap verifier and signed metadata. `install.sh` itself is trusted only once.

## On the user's machine [R9, R10]

```
~/.local/bin/cocalc                       launcher (POSIX sh, fixed; see below)
~/.local/share/cocalc/cli/
  node/<sha256>/                          verified Node trees, immutable
  targets/<sha256>/                       verified bundles and bootstraps, immutable
  tuf/                                    TUF client state: trusted root, metadata, highest-seen per role
  active                                  one line: <node sha256> <bootstrap sha256> <bundle sha256>
  previous                                the last active line (for rollback)
  lock                                    the update lock
```

- **The launcher** never parses JSON:
  - it reads `active`, a single line of three hex strings, and rejects anything else;
  - it checks that the three directories exist under the fixed root and aren't symlinks;
  - it clears `NODE_OPTIONS`, `NODE_PATH` and `NODE_REPL_EXTERNAL_MODULE`;
  - it then execs `node/<h>/bin/node targets/<b>/bootstrap.js run targets/<c>/cocalc.js -- "$@"`.
- **The bootstrap** re-hashes the bundle (about 10 ms) before running it. It also detects accidental corruption, but it isn't a defense against same-user tampering.
- **When Node changes**, the new tree comes with the release record and the pointer swap covers all three at once. The launcher itself is updated only by `cocalc update`, which rewrites it atomically from a signed target.
- **Recovery:** `install.sh` reinstalls from scratch. A broken `active` file makes the launcher print that recovery command.

## Updating [R7, R9, R11]

`cocalc update [--channel stable|candidate|dev] [--rollback]` is always user-initiated. A background check may only report that an update exists.

**The transaction:**
1. **Take the lock:** `lock`, exclusive, non-blocking with a wait message.
2. **Refresh and verify the metadata** through TUF:
   - the root chain;
   - the timestamp, which must not be expired;
   - the snapshot;
   - the role's targets.
   Pick the newest non-revoked target of the trusted role. Its version must be at least `highest_seen[role]`.
3. **Stage:** download every needed file into unique private staging (`O_EXCL`), with caps and timeouts, verify sizes and hashes, then extract safely.
4. **Sync:** fsync the files, rename into `node/<h>` and `targets/<h>`, and fsync the directories.
5. **Swap:** write `active.new`, fsync it, rename it over `active`, and fsync the directory. Record `previous` and `highest_seen`.
6. **Recover:** on startup, staging leftovers are deleted, and an `active.new` without the rename is discarded. Every crash point leaves either the old or the new state.

**Rollback** is local only, and the server can never trigger it. It may only go to a target that was verified on this machine before and isn't revoked. It changes `active` but never lowers `highest_seen`.

**Freshness** [R7]:
- expired timestamp metadata means no update, with a clear message;
- the clock checks (clock moved backwards against the last-seen metadata) are TUF's;
- air-gapped Star sites run a local mirror refreshed by their admin. A local setting `allow_expired_metadata_until <date>` exists only for that case and is shown on every update.

**GC:** `cocalc update --cleanup` keeps `active`, `previous`, anything the local CLI daemon has pinned, and the computers record. It deletes only unreferenced hash directories.

**The local CLI daemon** [R11]:
- **The handshake** announces the daemon's protocol version and bundle hash. A newer foreground CLI either talks to it if the protocol is compatible, or refuses with "run `cocalc daemon restart`".
- **Restarts are explicit:** `cocalc daemon restart` drains in-flight work first. Updating never restarts the daemon silently.

## Computers (decision 27) [R5]

A connected computer doesn't follow the CLI's `active` release. It has its own **computer release record**, `~/.local/share/cocalc/computers/<id>/release`:
- what it holds: the Node, bootstrap and connector hashes;
- who signs it: the offline `computers` role, never the CLI roles.

Rules:
- **Pinned paths.** The service (launchd/systemd, or the foreground connector) execs **absolute content-addressed paths** from that record. It never runs the global launcher or `active`.
- **GC roots.** CLI cleanup treats those paths as roots.
- **Updates.** Only `cocalc computer update`, run locally at a terminal with TTY confirmation, changes the record, and only to a target signed by the `computers` role. The computers protocol has no update operation: an agent or hub request to update is refused.
- **Honest scope.**
  - In **direct mode**, the agents' jobs run as the same user and can rewrite these files. So the offline key protects against the *release channels and hubs* changing a computer's code, not against same-user code.
  - In **isolated mode**, jobs run in a rootless container without write access to the record. That OS separation is what makes the claim hold against job code too.

## Version skew [R13]

- **Enforced by the hub.** Each hub has a minimum supported CLI version. The hub **enforces it at its API**: requests from a CLI below it (identified by a version header the CLI sends) get a specific error. A CLI that sends no header is a pre-manifest CLI, and the hub refuses only the operations that require newer behavior.
- **The client check is UX only.** The CLI reads `/cli/site.json` (cached up to 10 minutes) and stops early with: "This site needs cocalc ≥ X: run `cocalc update`". The cache only delays the friendly message, never enforcement.
- **Pre-manifest CLIs:** the setup scripts keep their "Usage: line names the subcommand" probe for those.

## Dev sites [R4]

Dev hubs such as lite1b build unsigned bundles. Running one means **full local code execution as you, by that site**: it can read every site's credentials and rewrite your CLI installation. The opt-in says exactly that:
- **The command:** `cocalc dev trust https://lite1b.cocalc.ai`. It requires the exact scheme, host and port, a typed confirmation, and a warning on every run.
- **Separate data directory:** dev bundles run with their own `COCALC_HOME`, separate from the stable install's credentials and release state. That reduces accidents but isn't a security boundary.
- **No inheritance:** a redirect never carries the opt-in to another origin.

Developers should use it on development machines (or a separate OS user), never where stable credentials matter.

## Windows (later phase) [R12]

- **Keep the SEA for now.** Windows stays on the signed SEA until this is done.
- **Its own launcher.** It gets a minimal native launcher: a few hundred lines, built and Authenticode-signed rarely, and listed as a signed target. A `.cmd` shim isn't a lossless argv boundary for `%`, `!`, `^`, `&` and quotes.
- **Required before shipping:**
  - adversarial argv tests;
  - user-only ACLs and reparse-point (junction) refusal;
  - atomic replacement that respects open-file rules (rename the old file aside, then GC);
  - architecture detection;
  - a PowerShell bootstrap with the same honest first-install trust.
- **Computers on Windows** stay WSL2-only, as already approved.

## Release pipeline

1. **Build.** Every merge to `main`: the build job makes the bundle (as it does for projects) and an attestation, and uploads `targets/<sha256>.js`.
2. **Sign dev builds.** The isolated signing job signs `cli-dev` metadata, then the snapshot and timestamp.
3. **Promote.** Candidate and stable come from re-signing an existing dev target (same bytes, same hash) under the candidate or stable role. Stable needs a manual approval.
4. **Verify Node upstream** [R8]. Bumping the Node version is a reviewed change. A CI job checks `SHASUMS256.txt.sig` against the pinned Node release keys, then records each archive's filename, platform, size and sha256 as signed targets. Clients never verify GPG.
5. **Serve.** Hubs embed the current stable root metadata and the installer for their build, and mirror the official metadata and targets.

## Rollout

1. **The signing foundation:** the TUF repository, KMS keys, the root ceremony (2 of 3), the isolated signing job, and Node upstream verification.
2. **The client:** the bootstrap verifier (`tuf-js` plus our policy), the launcher, `install.sh`, the `cocalc update` transaction, and the local daemon handshake. The hub serves `/cli/*`. Covered by adversarial tests: tampered metadata or targets, expiry, rollback, freeze, crash at every step, concurrent updates, size bombs, symlink and traversal archives, and environment injection.
3. **Version enforcement:** the hub's minimum-version check, plus the client message.
4. **Computers:** the release record and `cocalc computer update` with the offline role.
5. **Windows:** the native launcher, then retire the SEA everywhere.
6. *(Deferred)* per-site bundles, once site and role binding is designed.

## Open questions (for William)

- **Root key holders:** who holds the 2-of-3 offline root keys (e.g. YubiKeys)?
- **Node version:** Node 24 LTS or 26?
- **Is phase 1 too much?** A smaller first step would be to just fix the drift: hub-served `install.sh` plus the existing SEA with today's (weak) checks. The full TUF version would then be the real phase 1. This document assumes we go straight to the signed version, because the drift fix alone keeps today's weak trust model.
