# CoCalc CLI distribution: pinned Node + JS bundle, served by the hub

Status: revision 9 (Oct 13, 2026): answers @lite1-review on 0268b49d8c. Revision 8 answered 091cc355cb. Revision 7: Revision 6 phased the design, following William's point that the CLI shouldn't be held to a stricter standard than the hub's own release process. Revision 7 adds:
- **William's rule, as corrected on Oct 13:** releasing the CLI must be *easy*, one deliberate command, so it happens regularly. Not every hub release needs a CLI release.
- **@lite1-review's answers** on the honesty of the Phase A and B trust claims.

Revision 6 said: phased, following William's point that the CLI shouldn't be held to a stricter standard than the hub it talks to. Phases A and B come first; the full design (revision 5, approved at design level by @lite1-review at 9f4827a4df) is now **Phase C, the end state**.

Review history: Rev 1 (7e17dbc41f) got a REQUEST CHANGES security review from @lite1-review (8 high, 5 medium), answered in rev 2 (a157920c69); bracketed numbers such as [R2] refer to that review. Rev 2's review (2 high, 4 medium) was answered in rev 3 (85c9cba88d), with its findings cited as [S1]–[S6]. Revision 4 (59c5fac26d) answered rev 3's review (2 high, 1 medium), cited as [T1]–[T3]. Revision 5 answers rev 4's one medium finding [U1]: the exact pointer grammar, the launcher replacement inside the transaction, and how a future pointer format is introduced. William reviews after @lite1-review approves.

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

## Phasing: trust the CLI no more strictly than the release process

**The principle.** Installing or updating the CLI from an origin gives that origin **full code execution as your local OS user**. It can read any of your files, your SSH keys, and credentials for other sites. Browser JavaScript is sandboxed; the CLI is not, so this is more than you give a site by using it in the browser. (For a computer already connected in direct mode, the hub already has similar practical power, since its bays sign the tickets that run commands. That isn't true for every CLI user.)

The CLI's release trust should still rise **together with** the hub's, not ahead of it:
- The hub's own releases ship through ordinary CI and deploys, and the hub serves the web app, holds your account, and signs computer tickets.
- So defending the CLI more strictly than the hub's release path mostly moves the attacker to the hub.

Phase A therefore trusts whatever builds and deploys the site, says so plainly, and keeps the origin visible and explicit.

### Phase A: now (fixes drift and heavy releases)

**The rule: releasing the CLI is one easy, deliberate step.** Some hub releases have no reason to change the CLI, so a hub deploy doesn't release it automatically. Instead it is cheap enough to do whenever it's useful, which in practice means often.

**Release side:**
- **One command** builds the bundle, launcher and bootstrap from the current commit, writes the manifest with a new release number, uploads the content-addressed files, and then flips the origin's single pointer. For example: `pnpm --dir src/packages/cli release:cli`, also runnable as a manual GitHub workflow.
  - There's no signing ceremony. Node archives are pinned from Node's official signed checksums.
  - `--min-release this` (or a number) marks the CLI release the site wants. **It is advisory in Phase A:** an up-to-date CLI updates (or stops with a clear message) before using the site. An older CLI doesn't know the field, and a check that times out lets the command run. Real protocol compatibility is the API's job, not this check's.
- **Where releases live:**
  - for cocalc.ai, in the software bucket (software.cocalc.ai), which every bay reads, so there is one origin-wide pointer;
  - for dev and self-hosted sites, a local directory of the same layout, written by the same command with `--dir`.
- **The hub serves them under its own origin** (`/cli/*`). It fetches from the release store and verifies each file's hash before serving it, so clients only ever talk to the origin. Node archives are proxied the same way, from the upstream URL in the manifest, verified against its pinned sha256.
- The SEA builds stay for Windows only.

**What the hub serves:**
- `/cli/install.sh`.
- An **unsigned** `/cli/manifest.json`: the strict schema and size caps of the end state, pinning size and sha256 for the launcher, the bootstrap, the Node archive for each platform, and the bundle.
- Each of those files, by hash.
- For the `v1` pointer, **R is the sha256 of that manifest**, so the pointer and the shared update transaction cover every byte that executes.
- **One origin-wide publication authority.** An origin with several bays, or a rolling deploy, must never have bays disagreeing about the current release. Otherwise clients would oscillate between releases or get a manifest whose files another bay lacks. So publishing is ordered:
  1. Put all the immutable, content-addressed files on every serving bay, or in the shared store they all serve from.
  2. Publish the manifest the same way.
  3. Atomically flip a **single origin-level pointer** (in the database or shared store) that `/cli/site.json` on every bay reads.
  4. Keep old files through the rollback and GC window (at least the previous few releases).
- **The manifest carries a monotonic release number** (unsigned in Phase A).
  - Automatic updates only move forward. A stale or lagging answer never downgrades anyone.
  - A deliberate rollback by the site is published as a *new* release number whose contents are the older build.
  - **One release number maps to exactly one manifest hash.** The client remembers the number and hash of each release it has seen, and rejects an answer that reuses a number with a different hash. In Phase A this catches confused deploys, not a malicious site.

**Trust, stated plainly:**
- **The origin is fully trusted.** You trust the exact site you install from, and every later update from it, with full code execution as your local user (above).
- **What the checks are for:** HTTPS and the manifest hashes protect against network attackers, corruption and mixed-up files. They do not protect against the site.
- **No rollback protection** beyond the site's honesty. A malicious origin can do worse anyway.
- **The origin is explicit and visible:**
  - The CLI records the install origin, and `install.sh`, `cocalc update` and `cocalc version` print it prominently.
  - Updates fetch only from that exact origin. Cross-origin redirects are rejected. A CDN that serves that same origin name is inside the trust boundary: for cocalc.ai that's Cloudflare in front of it, which is already true for the web app. Phase B is about distribution *off* the origin, not CDN use as such.
  - Changing the origin (`cocalc update --from <site>`) needs an explicit local confirmation at a TTY, or `--yes`, showing both origins.
- **Node:** when the pinned version changes, the release job checks Node's signed `SHASUMS256` against the Node release keys. That is hygiene for an honest release, not protection for clients against a compromised site, which can pin any archive it likes.

**On the user's machine:**
- **The layout and mechanics of the end state:** the launcher, the pinned Node, the bundle, the exact `v1` pointer and the crash-safe update transaction.
- **Updates are automatic by default.** When the CLI talks to its origin, it reads `/cli/site.json` (cached up to 10 minutes). If the manifest hash differs from the active one, it fetches the new manifest and files, checks them, and swaps them in with the transaction.
  - The swap happens before the command runs, when the site requires the newer version.
  - Otherwise it happens in the background, for the next run.
- **Opting out:** `cocalc update --auto off`, or `COCALC_AUTO_UPDATE=0` for CI that wants pinned versions. `cocalc update` still updates by hand.
- **A local rollback places a hold.** `cocalc update --rollback` returns to the previous release and records `held_at=<that release>` for the origin.
  - It never lowers the highest release seen.
  - While held, nothing advances automatically, including to newer releases. Each run prints one short line, for example "held at 5; 7 is available: `cocalc update --resume`".
  - If the site requires a newer version, the command stops with that message instead of updating.
  - Only an explicit `cocalc update` or `cocalc update --resume` clears the hold.
- **Version skew** mostly disappears. With updates off, the CLI stops early with a clear "run `cocalc update`" message. The version header is for compatibility only.
- **Dev sites:** installing from a dev site such as lite1b is the opt-in, because the origin is shown, every update comes only from it, and switching away needs a confirmation.

**Computers:**
- **The record has two states:**
  - `current_release`: the exact manifest the daemon is running, so the Node, bootstrap and connector hashes;
  - `pending_release`: empty, or a release installed and waiting to be switched to.

  The record never claims the running release changed before it did. Both are GC roots.
- **No remote update operation:** the computers protocol has none. But the origin can trigger an update **indirectly**: through the CLI's ordinary automatic update, followed by the idle re-exec described next. The doc counts that as origin power, not as something the pin prevents.
- **Who changes what:**
  - **The local CLI's update transaction** (under its lock, after `active` has swapped) only sets `pending_release` on each eligible computer (next bullets). It never touches `current_release`.
  - **The daemon** never fetches anything. When `pending_release` is set, it switches with a barrier and a handshake:
    1. It closes admission: new operations are refused with a retryable "updating" error.
    2. It waits until no jobs are running. There is no deadline and it never kills jobs; admission stays closed meanwhile, so the wait can't race a new job.
    3. It records the switch in the record's journal and re-executes into `pending_release`, keeping its key and session.
    4. The new process checks the release's hashes and starts. Only then does it atomically set `current_release = pending_release` and clear `pending_release`, then reopens admission.
  - **Crash recovery:** on start, the launcher reads the journal.
    - If the new release didn't complete its handshake, it starts `current_release` (still the old one) and records the failure.
    - It retries the switch once, then leaves `pending_release` set with the error, for `cocalc computer update` to report.
- **Which computers switch automatically.** The two categories below don't overlap, and every computer falls in exactly one.
  - **Automatic: persistent (no time limit) direct-mode computers.** Direct mode gives every valid job arbitrary execution as the same user, so a job could replace the daemon anyway. The daemon's checks in direct mode (the ticket and effective-policy bindings, floors, attestations and local timing in `util/computers/protocol.ts`) authorize hub-issued work. They are not a boundary meant to survive arbitrary same-user direct jobs. So automatic replacement adds nothing the origin's tickets can't already do while the computer is connected.
  - **Pinned, changing only by `cocalc computer update` at the local TTY:**
    - **Isolated computers.** There the daemon and the OS enforce a boundary meant to survive hub-issued jobs (the container, mounts, network and resource ceilings).
    - **Direct-mode computers with an owner-controlled restriction** meant to survive hub-issued jobs, if we ever add one.
    - **Time-limited computers.** Restarting the process ends them, so they keep their release until they end.
- **Too-old daemons:** the hub's minimum version refuses a daemon that is too old, with a message saying how to update.
- **What the pin is for:** it stops accidental drift and any remote protocol request from changing the code. It is no defense against a compromised site-served CLI or any other code running as the same user, which can rewrite the record whenever it runs. Phase B and C signatures authenticate release bytes, but don't change that either (see "Computers" below).
- **The strict decision 27** (offline-signed updates, never automatic) is Phase C.

**Windows** keeps the signed SEA.

### Phase B: when release bytes are distributed off the origin (R2, a separate CDN host, Star mirrors)

**When:** as soon as release bytes come from somewhere other than the origin the person chose, or we deliberately take the same-origin CDN out of the trust boundary. A CDN in front of the origin's own name is not the trigger. From then on we sign what we publish. Automatic updates continue, now verified. One person's keys are enough:
- **Root key:** on a YubiKey, held by William. It's used rarely, to certify a release key for at most a year, and to revoke it.
- **Release key:** in CI or a KMS, certified by the root. It signs every release manifest.
- **The client** verifies, against the embedded root public key:
  - the certificate chain;
  - the manifest signature and expiry;
  - a monotonic release sequence, with the two-state rollback rule (`highest_seen` versus `active`).
- **Root and certificate metadata are rollback-protected** too: a monotonic version, and the client never accepts an older certificate or rotation than it has seen. A revocation supersedes the release-key sequence: once seen, no manifest signed by the revoked key is accepted, whatever its sequence.
- **Withholding a revocation** has two cases. They are different and must not be confused:
  - **A distributor alone, without the release key:** it can only withhold new metadata, so it can freeze or replay *old, legitimately signed* releases. That is availability, bounded by manifest and certificate expiry.
  - **A compromised release key, with a distributor that withholds the revocation** (or a client that simply hasn't seen it): the key is still a **code-signing authority**. It can sign a malicious automatic update, which means full code execution as the user. That lasts until the client observes the revocation or the certificate expires. This is why certificates are short-lived (at most a year, and shorter is better), and why the client fetches revocation status from the origin and from the distribution path.

**The root of trust must be pinned before untrusted distribution enters the path.** If `install.sh` or the root key is itself fetched from a compromised CDN, R2 or mirror, that distributor can substitute its own root, and the signatures prove nothing. So Phase B protects only clients whose root was embedded:
- by an already trusted Phase A launcher or update;
- by an installer served directly by the trusted hub the person chose;
- or by an authenticated out-of-band installer or package.

**A durable trust mode per installation.** Phases A and B coexist: each installation (and so each origin it follows) is in one mode, not the whole world at one migration instant. The installation records its mode durably beside the pointer:
- **`origin-trust`:** Phase A rules. The recorded origin is fully trusted.
- **`signed`:** the embedded root, its rollback state and the channel.

The rules:
- **A `signed` installation never falls back to unsigned**, whatever its origin advertises. "This site has its own build" is not a reason to accept unsigned bytes.
- **Moving from `signed` to `origin-trust` is an explicit local trust downgrade.** It happens only at the local TTY (or with an explicit flag in scripts), showing the origin and the full-code-execution warning. Never automatically.
- **Moving from `origin-trust` to `signed`** is a normal update from a trusted origin, which embeds the root.
- **A self-hosted site serving its own build** (see per-site bundles) serves `origin-trust` installations. Its users choose that when they install from it.

**Then, honestly, for `signed` installations:**
- **Protected:** a compromised R2, CDN or mirror, or a site serving release bytes we never signed. Without the release key they can only deny service, delay, or freeze and replay old signed releases until expiry.
- **Not protected:**
  - a first install bootstrapped from the compromised distributor;
  - a compromised release key, until the client observes the revocation or the certificate expires (full code execution, see above);
  - a compromised build pipeline;
  - a malicious release that already ran (full same-user compromise; recovery is out of band).

### Phase C: the end state (the full design below)

TUF roles with an offline threshold root, the offline runtime role and its ceremony, an independent reproducible rebuild for stable, and a transparency log.

**When:** together with hardening the hub's own release path (signed deploys and reviewed release builds), once there is more than one developer, or once customers require it. **Every section below, from "Threat model" on, describes Phase C**, and its threat claims are Phase C's. For example, "a malicious site after install can't push code" is false in Phases A and B. Phases A and B share the mechanics (launcher, pointer, transaction, layout) with the trust described above.

### Later, in any phase

- **Windows:** its own native launcher (see below). Until then it keeps the signed SEA.
- **Per-site bundles:**
  - In Phase A they are simply how it works: each site serves the CLI from its own build, modified or not, and its users trust that site.
  - Phase B signs only the releases we publish. A site serving its own build serves `origin-trust` installations; a `signed` installation never accepts it without the explicit local downgrade.
  - What stays deferred is *signed* per-site channels in Phase C, until site and role binding is designed [R6].

## Threat model (Phase C)

| Threat | In scope? | Outcome with this design |
|---|---|---|
| Network attacker (MITM) | yes | Stopped. HTTPS for transport, plus signed metadata for everything after bootstrap. |
| Compromised CDN, R2 or mirror **after** a trusted bootstrap | yes | Can only deny service or delay. All content must match signed TUF metadata, and expiring timestamp metadata bounds freeze or replay. |
| Compromised CDN or site **at first install, or on any `curl \| sh` re-run** | **no** (stated honestly) [R1] | Full code execution as the user. `curl \| sh` trusts the origin that finally serves the script, and its CDN, completely. This is the same for every `curl \| sh`. Mitigations: below. |
| Malicious or compromised site after install | yes | Can't push code. A site only names a target that already exists in the signed channel metadata the client trusts. |
| Compromised CI or build pipeline | yes, **not contained** [S1] | The key can't be stolen (non-exportable KMS, isolated signing job), but the signer is an **oracle**. A compromised authorized builder or workflow can produce malicious bytes with valid provenance, and they get signed. Provenance says where bytes came from, not that they are good. So a compromised builder *can* produce signed dev and candidate releases, and stable ones with a manual approval. Stable hardening below. A malicious commit that passes review is also out of scope, as for any release process. |
| Compromised online signing key (timestamp/snapshot) | yes | Bounded by short expiry. Rotated by targets or root; can't create new targets. |
| Compromised targets key (e.g. `cli-stable`) | yes, **limited to bundles** [S2] | Can sign bad **bundles** until root revokes the delegation. It can't replace the launcher, bootstrap verifier or Node: those are signed only by the offline `runtime` role. Revocation only stops *subsequent* installs. A client that already ran a malicious bundle is compromised (next row). |
| A malicious signed bundle that already ran | **no recovery in-band** [S2] | The bundle runs as you, so it can rewrite the launcher, TUF state, `active` and every computer release record, and steal credentials. That is full same-user compromise. Recovery is out of band: a clean reinstall from a trusted path, rotating the CoCalc credentials it could read, and incident response. The update system can't clean an account that ran attacker code. |
| Compromised root keys (threshold) | no | Offline hardware, threshold. Out of scope beyond holding them carefully. |
| Compromised Node download or mirror | yes | The runtime ceremony verifies Node's signed `SHASUMS256` against the pinned Node release keys [R8, T1]. |
| Compromised Node project or Node release key | **no (a trust assumption)** [T1] | A malicious release signed by Node's own keys passes. We trust the Node project, as every Node user does. |
| Insider or targeted equivocation (a different signed release for one victim) | **undetected until a transparency log exists** [S3] | Someone holding the relevant delegated plus snapshot and timestamp keys can serve one victim a separately signed metadata chain. Snapshot pinning only prevents rollback for that client and doesn't make the target public. Detecting this needs an append-only log with independent monitors: later hardening, e.g. publishing each metadata version to a public transparency log that clients require. |
| Freeze or replay (serving old metadata) | yes | TUF timestamp expiry. Clients refuse expired metadata unless a local offline policy explicitly allows it [R7]. |
| Disk, stream or memory exhaustion | yes | Size caps on metadata and downloads, timeouts, and unpacked-size and file-count limits [R8]. |
| Partial, crashed or concurrent updates | yes | A transaction with a lock and atomic pointer swap, plus crash recovery [R9]. |
| Environment injection (`NODE_OPTIONS`, `NODE_PATH`, proxy, custom CA) | partly | The launcher clears `NODE_OPTIONS` and `NODE_PATH` [R10]. A proxy or custom CA trusted by the system can't forge signed metadata, so **update authenticity survives**. It **can** read and modify ordinary API traffic, stealing CLI cookies and tokens and user data, exactly as for any TLS client that trusts the system CAs [S4]. |
| Same-user or local-admin compromise | **no** | Anything running as you can rewrite your files. That includes an unsigned dev bundle you opted into [R4] and direct-mode computer jobs [R5]. |

**Reducing first-install trust [R1].**
- `install.sh` is small and readable. Docs publish its sha256 per release. That helps only if you get the hash through an independent, authenticated channel (e.g. the signed git tag or release notes), not from the same site or CDN [T3].
- **Every actual `curl | sh` re-run fully re-trusts the final origin** [T3]. The legitimate script prefers the installed, signature-verified `cocalc update` when a launcher exists, but that is a convenience: a malicious script would simply skip it. To avoid re-trusting a site, people with an installed CLI run `cocalc update` or `cocalc setup …` **directly**, not the `curl` line. The setup dialogs say so: they show the local command first when the person has the CLI, and the `curl` line for first installs.
- Anyone who needs a CDN-proof first install can use an out-of-band path: a package manager, or the signed SEA, until that is retired.

## Signing: TUF roles (Phase C) [R2, R3, R6, R7]

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
| `runtime` | the trusted computing base: launcher, bootstrap verifier, Node archives [S2] | **offline**, 2 of 3; changes rarely (a Node bump or verifier fix) | 6 months |
| `cli-stable` | stable CLI **bundles only** | KMS, non-exportable; used only by the release signing job, after a manual approval | 3 months |
| `cli-candidate`, `cli-dev` | candidate and dev **bundles only** | KMS (separate keys); signed automatically per main commit | 1 month |
| `computers` | computer daemon releases (decision 27) | **offline**, separate from all CLI keys | 6 months |
| `snapshot`, `timestamp` | which metadata versions are current, and freshness | KMS, online | snapshot 7 days, timestamp 1 day |

- **CI isolation [R2].**
  - The build job produces the bundle and a provenance attestation and never sees a signing key.
  - A separate signing job, a few dozen lines in its own workflow, does no checkout and runs no repository code. It receives the artifact digest and size, checks the attestation, gets KMS access through GitHub OIDC (no exportable secret), and signs the metadata.
  - Stable signing needs a protected environment with manual approval.
  - **What this does and doesn't buy [S1].** It protects the key. It doesn't stop a compromised builder from getting malicious bytes signed: the signer is an oracle.
- **Stable hardening: independent reproducible rebuild [S1].** Before `cli-stable` may sign, a second builder rebuilds the bundle from the same approved source revision and its sha256 must match exactly. That builder is administered independently (a machine outside GitHub Actions, e.g. one held by William). The signing policy binds three things: the approved revision, the protected workflow, and both builder identities. This needs a reproducible bundle build (esbuild/ncc with pinned dependencies and no embedded timestamps), which Phase C must make and test. Until then, the threat-model row above stands as written.
- **Separate trust for the runtime [S2].** The launcher, bootstrap verifier and Node form the client's trusted computing base. Only the offline `runtime` role signs them, so a compromised online `cli-*` key can't replace the verifier or Node. Bundles from `cli-*` roles are verified by that fixed runtime.
- **Channels are roles [R6].** A stable client trusts only `cli-stable` targets. Candidate and dev need an explicit local opt-in (`cocalc update --channel candidate`), and highest-seen state is tracked per role. A dev build can't raise a stable client's floor.
- **Revocation and recovery [R2, R7].**
  - *A bad signed release:* the role signs metadata that removes the target, and lists it as revoked in a custom field the client honors. Clients that haven't run it never will. Clients that already ran a *malicious* one are treated as compromised, as described in the threat model: recovery is out of band. Clients on a merely *buggy* one are told to update or roll back.
  - *A compromised delegated key:* the threshold of `targets` and `root` rotates the delegation. Old signatures stop verifying after the next root or targets version.
  - *A compromised online key:* rotated the same way, with exposure bounded by expiry.
  - *Lost root keys:* a threshold means one lost key isn't fatal. Losing two needs a manual re-bootstrap announced out of band.

## Two independent targets (Phase C) [T2]

The client composes two separately signed targets. Neither authority can stand in for the other.

| | Runtime target | Bundle target |
|---|---|---|
| Signed by | `runtime` (offline, 2 of 3) | `cli-stable`, `cli-candidate` or `cli-dev` (KMS) |
| Delegated path namespace | `runtime/*` only | `cli/<channel>/*` only |
| Contains | launcher, bootstrap verifier, Node archives per platform, `runtime_sequence`, `pointer_format` | the bundle only, plus `min_runtime_sequence` |
| Floor and revocation | `highest_seen[runtime]`, runtime revocation list | `highest_seen[cli-<channel>]`, that role's revocation list |

- **The namespaces are disjoint.** The delegations in `targets` restrict each role to its path prefix. A target outside its role's prefix is rejected, so `cli-*` metadata can never name a launcher, bootstrap or Node.
- **The verifier checks both independently:** signatures, thresholds, expiry, revocation and floors per role. A bundle can *require* a minimum `runtime_sequence`, but can never *select* or *downgrade* runtime bytes. If the installed runtime is too old for the newest bundle, the client first updates the runtime (from runtime-signed metadata only). If it can't, it keeps the current bundle and says why.
- **`active` is not an authority.** It's a locally derived pointer, written only after both targets were verified. The launcher trusts it only to point into content-addressed directories that the verifier already populated. Its exact grammar is below [U1].
- **The pointer format is frozen at `v1` from Phase A on** [U1]. Changing it later needs a two-release bridge:
  1. a runtime release whose launcher reads both `v1` and `v2`, while its bootstrap still writes `v1`;
  2. a later runtime release whose bootstrap writes `v2`.

  Launchers only ever gain formats and never drop one, so the launcher installed by a transaction can always read the pointer that transaction leaves behind, old or new. An old bootstrap never has to construct a format it doesn't know: the new-format pointer is written only by a bootstrap that ships with a launcher that reads it.

## The runtime ceremony (Phase C) [T1]

The offline `runtime` keys sign only what the signers have proven themselves. A CI-produced digest or attestation is never accepted as proof.

1. **Node:** at least two signers each, independently:
   - download the pinned Node version's archives and `SHASUMS256.txt` / `.sig` from nodejs.org;
   - verify the signature against the pinned Node release key set (kept in the repo and reviewed);
   - check that the archive hashes match.
2. **Launcher and bootstrap verifier:** rebuilt reproducibly from the approved source revision by at least two independently administered builders, whose hashes must agree. The launcher (about 50 lines of sh) is small enough that signers also read its exact bytes.
3. **Only when all of that matches** do 2 of 3 signers sign the runtime target. The ceremony's inputs and the hashes each signer computed are recorded in the runtime release notes.

## What every hub serves (Phase C)

Unauthenticated GETs, all bytes only; trust comes from TUF metadata, never from the site:

| Path | What |
|---|---|
| `/cli/install.sh` | the installer, built with this hub. It embeds the root metadata, plus the expected sha256 and size of the bootstrap verifier and Node archive for each platform [R1] |
| `/cli/tuf/<role>.json`, `/cli/tuf/<version>.root.json` | a mirror of the TUF metadata (bytes only; signatures decide) |
| `/cli/targets/<sha256>.<ext>` | bundles, bootstrap verifiers, Node archives, content-addressed (`immutable`, edge-cached) |
| `/cli/site.json` | **unsigned hint**: this hub's minimum supported CLI version and the target it recommends. The client uses it only to pick among targets it already trusts, so the hint can't add code |

- **Redirects [R6]:** the client never follows a cross-origin redirect for metadata. Mirrors for target bytes must appear in signed metadata (a custom `mirrors` list in `targets`).
- **The source of truth:** official metadata lives at `software.cocalc.ai` and in R2. Hubs and Star sites mirror it; a hub has no signing authority.

## Install (first time) (Phase C) [R1, R8, R10]

`curl -fsSL <site>/cli/install.sh | sh` runs these steps under `umask 077`:

1. **Pick the platform.** Detect OS and arch. Refuse unsupported ones and symlinked install directories.
2. **Fetch and check Node.** Download the pinned Node archive (content-addressed, size-capped, with a timeout). Check its size and sha256 against the values embedded in `install.sh`, using `sha256sum` or `shasum -a 256`, before extracting.
3. **Extract safely** into private staging with these checks:
   - no absolute paths, `..`, or links leaving the tree;
   - caps on file count and unpacked size.

   Then rename into `node/<sha256>/`.
4. **Fetch the bootstrap verifier.** This is `bootstrap.js`: `tuf-js` plus our policy, a small fixed program. Download it and check it against the embedded sha256.
5. **Verify both targets** [T2]. Run the verifier with the pinned Node and a cleared environment. It initializes TUF from the embedded root, fetches the timestamp, snapshot and targets metadata, then verifies the two independent targets (below):
   - the **runtime target**, signed by `runtime`: it must be the one embedded in `install.sh`, or a newer runtime-signed one;
   - the **bundle target**, signed by `cli-stable`, whose minimum runtime must be satisfied by that runtime.
6. **Commit.** Download and verify the bundle, install the launcher from the runtime target, and write the local `active` tuple (all of it in the transaction below).

From then on, everything goes through the bootstrap verifier and signed metadata. `install.sh` itself is trusted only once.

## On the user's machine (Phase C) [R9, R10]

```
~/.local/bin/cocalc                       launcher (POSIX sh, fixed; see below)
~/.local/share/cocalc/cli/
  node/<sha256>/                          verified Node trees, immutable
  targets/<sha256>/                       verified bundles and bootstraps, immutable
  tuf/                                    TUF client state: trusted root, metadata, highest-seen per role
  active                                  the pointer, exact v1 grammar below
  previous                                the last active line (for rollback)
  lock                                    the update lock
```

- **The launcher** never parses JSON:
  - it reads `active`, which must be exactly one line in the **v1 grammar** [U1]: `v1 <R> <N> <B> <C>\n`, five tokens separated by single spaces. `R`, `N`, `B` and `C` are each 64 lowercase hex characters:
    - `R` is the sha256 of the runtime target file (the runtime manifest in `runtime/*`);
    - `N` is the sha256 of the Node archive that was verified and extracted to `node/<N>/`;
    - `B` is the sha256 of the bootstrap file in `targets/<B>/`;
    - `C` is the sha256 of the bundle's content, which is also its TUF bundle-target hash, in `targets/<C>/`.

    Anything else (another token count, another version, extra bytes, a missing newline) is rejected, and the launcher prints the recovery command;
  - it checks that `node/<N>`, `targets/<B>` and `targets/<C>` exist under the fixed root and aren't symlinks;
  - it clears `NODE_OPTIONS`, `NODE_PATH` and `NODE_REPL_EXTERNAL_MODULE`;
  - it then execs `node/<N>/bin/node targets/<B>/bootstrap.js run targets/<C>/cocalc.js -- "$@"`. The bootstrap re-checks that `R` names a verified runtime target listing exactly these `N` and `B`.
- **The bootstrap** re-hashes the bundle (about 10 ms) before running it. It also detects accidental corruption, but it isn't a defense against same-user tampering.
- **When the runtime changes** (Node, bootstrap or launcher), it arrives only in a runtime-signed target [T2], and the transaction below handles it: new trees, then the launcher, then `active`.
- **Recovery:** `install.sh` reinstalls from scratch. A broken `active` file makes the launcher print that recovery command.

## Updating (Phase C) [R7, R9, R11]

`cocalc update [--channel stable|candidate|dev] [--rollback]` is always user-initiated. A background check may only report that an update exists.

**The transaction:**
1. **Take the lock:** `lock`, exclusive, non-blocking with a wait message.
2. **Refresh and verify the metadata** through TUF:
   - the root chain;
   - the timestamp, which must not be expired;
   - the snapshot;
   - the role's targets.
   Then select **separately** [T2]:
   - **the runtime:** the newest non-revoked runtime target, at least `highest_seen[runtime]`;
   - **the bundle:** the newest non-revoked bundle target of the trusted channel role, at least `highest_seen[cli-<channel>]`, whose `min_runtime_sequence` that runtime satisfies.
3. **Stage:** download every needed file into unique private staging (`O_EXCL`), with caps and timeouts, verify sizes and hashes, then extract safely.
4. **Sync:** fsync the files, rename into `node/<h>` and `targets/<h>`, and fsync the directories.
5. **Raise the floors first [S6].** Write the newly trusted TUF metadata and the new `highest_seen` for **both** roles durably (write, fsync, rename, then fsync the directory) **before** exposing the new code. A crash here leaves the old `active` with a higher floor, which is safe: the next update simply continues.
6. **Journal, then switch** [U1]:
   1. write `transition` = {from: old `active` line, to: new line} durably;
   2. **if the runtime changed**, install the runtime-signed launcher atomically: write `cocalc.new` next to it, fsync it, rename it over `~/.local/bin/cocalc`, and fsync the directory;
   3. write `active.new`, fsync it, rename it over `active`, and fsync the directory;
   4. write `previous` = the `from` line durably, and delete `transition`.
7. **Recover:** on startup:
   - staging leftovers are deleted;
   - a `transition` whose `to` is already `active` is completed (it writes `previous`);
   - a `transition` whose `to` isn't `active` is discarded, along with any `active.new` and `cocalc.new`. **A newer launcher that was already installed is deliberately kept** [U1]: it reads every earlier pointer format, so it works with the old `active`.

   Every crash point leaves either the old or the new active state, with a floor at least as high as before. Crash tests cover every step, including:
   - between the floors and the journal;
   - just before and just after the launcher replacement;
   - between the launcher replacement and the `active` swap;
   - for a format bridge, the first run of the new bootstrap that writes the new format.

**Rollback** is local only, and the server can never trigger it. It may only go to a target that was verified on this machine before and isn't revoked. It changes `active` (and so which Node, bootstrap and bundle run) but never lowers `highest_seen`, and it **leaves the newer launcher installed** [U1], since launchers are backward compatible by rule.

**Freshness** [R7]:
- expired timestamp metadata means no update, with a clear message;
- the clock checks (clock moved backwards against the last-seen metadata) are TUF's;
- air-gapped Star sites run a local mirror refreshed by their admin. A local setting `allow_expired_metadata_until <date>` exists only for that case and is shown on every update.

**GC:** `cocalc update --cleanup` keeps `active`, `previous`, anything the local CLI daemon has pinned, and the computers record. It deletes only unreferenced hash directories.

**The local CLI daemon** [R11]:
- **The handshake** announces the daemon's protocol version and bundle hash. A newer foreground CLI either talks to it if the protocol is compatible, or refuses with "run `cocalc daemon restart`".
- **Restarts are explicit:** `cocalc daemon restart` drains in-flight work first. Updating never restarts the daemon silently.

## Computers (decision 27) (Phase C) [R5]

A connected computer doesn't follow the CLI's `active` release. It has its own **computer release record**, `~/.local/share/cocalc/computers/<id>/release`:
- what it holds: the Node, bootstrap and connector hashes;
- who signs it: the offline `computers` role, never the CLI roles.

Rules:
- **Pinned paths.** The service (launchd/systemd, or the foreground connector) execs **absolute content-addressed paths** from that record. It never runs the global launcher or `active`.
- **GC roots.** CLI cleanup treats those paths as roots.
- **Updates.** Only `cocalc computer update`, run locally at a terminal with TTY confirmation, changes the record, and only to a target signed by the `computers` role. The computers protocol has no update operation: an agent or hub request to update is refused.
- **Honest scope [S2].** The offline `computers` key protects against these changing a computer's code:
  - hubs;
  - the computers protocol;
  - an honest updater, and accidental drift from CLI channels.

  It does **not** protect against code running as the same user, which can rewrite the record. That includes:
  - a malicious ordinary CLI bundle (even a signed one);
  - in direct mode, the agents' jobs.

  In isolated mode, job code is containered and can't write the record, but the user's own CLI can. Real protection against same-user code needs an OS boundary: a root-owned updater and record, or a separate service user. That is an option for later, beyond Phase C.

## Version skew (Phase C) [R13]

- **The version header is for compatibility, not security [S5].** The CLI sends its version, and the hub uses it to give old clients a clear "please update" error. Any client can forge the header, so **no security property depends on it**. Every security check is enforced from the request itself (auth, required protocol fields and capabilities, server state), regardless of the claimed version. When an operation needs newer behavior, the hub requires the fields or capabilities that behavior adds. A request without them is refused for that reason, not because of the binary's claimed identity.
- **The client check is UX only.** The CLI reads `/cli/site.json` (cached up to 10 minutes) and stops early with: "This site needs cocalc ≥ X: run `cocalc update`". The cache only delays the friendly message, never enforcement.
- **Pre-manifest CLIs:** the setup scripts keep their "Usage: line names the subcommand" probe for those.

## Dev sites (Phase C) [R4]

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

## Release pipeline (Phase C)

1. **Build.** Every merge to `main`: the build job makes the bundle (as it does for projects) and an attestation, and uploads `targets/<sha256>.js`.
2. **Sign dev builds.** The isolated signing job signs `cli-dev` metadata, then the snapshot and timestamp.
3. **Promote.** Candidate and stable come from re-signing an existing dev target (same bytes, same hash) under the candidate or stable role. Stable needs a manual approval and, once reproducible builds land, a matching independent rebuild [S1]. A manual approval of bytes isn't evidence that they match the reviewed source; the independent rebuild is.
4. **Runtime releases** (a Node bump, or a launcher or bootstrap change) don't go through CI signing at all. They go through the runtime ceremony [T1]: independent Node verification and independent reproducible rebuilds before the offline 2-of-3 signature [S2]. CI may *prepare* a candidate runtime target for convenience, but it is only a proposal. Clients never verify GPG; the signed runtime target pins each Node archive's filename, platform, size and sha256.
5. **Serve.** Hubs embed the current stable root metadata and the installer for their build, and mirror the official metadata and targets.

## Rollout (Phase C; Phases A and B are described in Phasing)

1. **The signing foundation:**
   - the TUF repository and KMS keys;
   - the root and runtime ceremonies (2 of 3);
   - the isolated signing job and Node upstream verification;
   - a reproducible bundle build, plus an independent rebuilder for stable [S1].
2. **The client:** the bootstrap verifier (`tuf-js` plus our policy), the launcher, `install.sh`, the `cocalc update` transaction, and the local daemon handshake. The hub serves `/cli/*`. Covered by adversarial tests: tampered metadata or targets, expiry, rollback, freeze, crash at every step, concurrent updates, size bombs, symlink and traversal archives, and environment injection.
3. **Version enforcement:** the hub's minimum-version check, plus the client message.
4. **Computers:** the release record and `cocalc computer update` with the offline role.
5. **Windows:** the native launcher, then retire the SEA everywhere.
6. *(Deferred)* signed per-site channels, once site and role binding is designed. Unsigned per-site bundles are Phase A.

## Open questions (for William)

Decided (William, Oct 13):
- **Node 26.** It has `node:sqlite` without the experimental warning (checked on 26.11.1), which the CLI needs, and projects already run 26.
- **The default update source is the site you installed from**, not software.cocalc.ai. Self-hosted sites can build and serve their own modified CLI, and developers can test their builds without publishing rights anywhere.

Still open, for later phases:

- **Root key holders (Phase C):** who holds the 2-of-3 offline root keys (e.g. YubiKeys)?
- **The independent rebuilder for stable [S1] (Phase C):** whose machine, and is it worth the operational cost?
- **Transparency log [S3]:** in Phase B or C?
