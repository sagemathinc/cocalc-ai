# CoCalc CLI distribution: pinned Node + JS bundle, served by the hub

Status: draft (Oct 12, 2026). Security review by @lite1-review first, then William.

## Why change

What went wrong on Oct 12 while testing the one-line setup (`curl … | sh`):

- **The installer drifted.** `software.cocalc.ai/software/cocalc/install.sh` predates the bash 3.2 fix that has been in the repo since Sep 29 (e423f383c3). On macOS, `/bin/bash` 3.2 fails with `runtime_env[@]: unbound variable` before the CLI ever runs.
- **The CLI drifted.** The `latest` channel is from July and has no `computer` command. No hub says which CLI goes with it, and a dev hub such as lite1b can't hand out its own CLI.
- **Releases are heavy, so they are rare.** Every release is a manual workflow that builds a Node SEA per platform (48 MB gzipped, 147 MB on disk each). It signs and notarizes the macOS build on a Mac runner and signs the Windows build with Microsoft Artifact Signing.
- **Skew fails obscurely.** One installed CLI talks to many sites (cocalc.ai, someone's Star, lite1b), each at its own version. A missing feature shows up as "unknown command" deep inside a step.

## Facts this design relies on

- **The CLI is one JavaScript file:** `cocalc-cli.js`, 6.3 MB, 1.65 MB gzipped.
  - It uses only Node built-ins, including `node:sqlite` (Node 22.5+). There are no native addons and no `dlopen`.
  - Projects already run it this way: `bin2/cocalc-cli` is `exec node cocalc-cli.js "$@"`.
- **Every hub build already contains that bundle**, since it ships to projects.
- **Official Node builds are already signed.** They are 26–32 MB per platform, signed and notarized for macOS and Authenticode-signed for Windows by the Node project, and published with signed checksums (`SHASUMS256.txt`).
- **Files fetched by `curl` aren't quarantined** on macOS, so Gatekeeper doesn't evaluate them. A JavaScript file run by a signed `node` needs no signature of its own from Apple's point of view.

## Design

### On the user's machine

```
~/.local/bin/cocalc                         launcher: about 15 lines of POSIX sh
~/.local/share/cocalc/cli/
  node/v24.x.y/bin/node                     official Node, pinned version
  bundles/<sha256>/cocalc.js                verified bundles, content-addressed
  current.json                              the bundle `cocalc` runs (signed manifest)
  keys/                                     trusted CoCalc release public keys
```

The launcher runs the pinned Node on the current bundle and nothing else. It never uses a `node` from PATH, because distro packages are often too old. Bundles are never modified in place, so a running process keeps its file. Windows gets the same layout under `%LOCALAPPDATA%\CoCalc\CLI`, with a `cocalc.cmd` launcher.

### What every hub serves

All of these are unauthenticated GETs:

| Path | What | Caching |
|---|---|---|
| `/cli/install.sh`, `/cli/install.ps1` | the installer from this hub's own build | short (`max-age=300`) |
| `/cli/manifest.json` | this hub's signed release manifest (below) | short |
| `/cli/bundles/<sha256>.js` | the bundle, by hash | `public, max-age=31536000, immutable` (edge-cached forever) |
| `/cli/node/<version>/<file>` | optional mirror of the official Node archives (Star, air-gapped) | immutable |

The hub serves the bundle it was built with, so the CLI and its hub can't drift apart. The one-line setup scripts (`/api/v2/cli/setup`) install from the hub they came from instead of from `software.cocalc.ai`.

### The release manifest

```json
{
  "type": "cocalc-cli-release", "version": 1,
  "cli": { "version": "2026.10.12+97bb52a", "sequence": 1234, "git": "97bb52a…",
           "sha256": "…", "size": 6293691 },
  "node": { "version": "24.x.y",
            "files": { "linux-x64": { "file": "node-v24.x.y-linux-x64.tar.xz", "sha256": "…" },
                       "linux-arm64": { "…": "…" }, "darwin-arm64": { "…": "…" },
                       "win-x64": { "…": "…" } } },
  "min_cli_sequence": 1200,
  "issued_at": 1791847000000,
  "signature": { "kid": "cli-2026-1", "alg": "ed25519", "sig": "…" }
}
```

- `sequence` increases with every release. `min_cli_sequence` is the oldest CLI this hub supports (see skew).
- Node archives are pinned by sha256 inside the signed manifest. The installer therefore doesn't need gpg to trust Node, and a mirror (R2, a Star hub) can serve them unchanged.

### Trust model

These are the threats, and what each one gets an attacker:

1. **Network attacker.** HTTPS stops them; the signature also stops a forged mirror.
2. **A compromised CDN, R2 bucket or Node mirror.** It can't serve anything that runs: every bundle and Node archive must match a sha256 in a manifest signed by a CoCalc release key.
3. **A compromised or malicious site.**
   - **First install:** `curl <site>/cli/install.sh | sh` trusts that site completely, exactly as today and as any `curl | sh`. The installer embeds the CoCalc release public keys.
   - **After installation:** a site can't push code. The launcher only switches to manifests signed by a trusted key, and only to a higher `sequence`, so there are no downgrades.
   - A site can choose among official builds. It can't build its own.
4. **A compromised build pipeline.** It holds the signing key, the same exposure as today's macOS and Windows signing secrets. Mitigations:
   - The key lives in the protected `cocalc-cli-signing` GitHub environment, which needs a review before a release job runs.
   - `kid` allows rotation: the launcher trusts a short list of keys, and a new key is introduced by a statement signed with the old one.
   - Later, the key could live in a KMS that signs, without ever being exportable.

**Dev sites (lite1b, local hubs).** They build unsigned bundles. The launcher runs an unsigned bundle only for a site the person has explicitly opted in, with `cocalc site trust-dev <url>`. It says so loudly on every command against that site, and such a bundle is never used for any other site.

**Computers (decision 27).** A connected computer's daemon never switches bundles on its own. It runs the bundle it was started with, pinned by hash. It updates only with `cocalc computer update`, which requires a release signed by the offline computers key. A hub can't change the code on a computer.

### Version skew

- **The check:** every CLI request to a site first reads `<site>/cli/manifest.json`, cached per site for an hour. If the installed CLI's `sequence` is below the site's `min_cli_sequence`, the command stops with a clear message instead of an obscure error: "This site needs a newer cocalc. Run: cocalc update --from <site>".
- **The probe stays as a fallback.** The setup scripts keep the "Usage: line names the subcommand" probe for CLIs that predate the manifest.
- **Phase 2, per-site bundles.** When talking to a site, the launcher may run that site's own signed bundle, fetched by hash and cached. Each site then gets exactly the code it was built with. Only signed bundles qualify, and dev sites only with the opt-in above. This is a separate decision; phase 1 doesn't depend on it.

### Updating

- **Commands:** `cocalc update [--from <site>]` downloads to a temp file, verifies the signature and sha256, moves the result into `bundles/<sha256>/`, then atomically replaces `current.json`. It keeps the previous three bundles for `cocalc update --rollback`.
- **No silent updates:** a background check may say an update exists, but it never installs. This holds especially for long-running processes: the CLI's local daemon and a computer's daemon.
- **Node changes rarely:** a manifest with a new Node version makes `cocalc update` fetch and verify that one too.

### Release pipeline

- **Every commit to `main`** builds the bundle (it already does, for projects), signs a manifest, and uploads `bundles/<sha256>.js` to R2. Channels (`dev`, `candidate`, `stable`) become pointers to signed manifests.
- **Every hub deploy** includes its bundle and that commit's signed manifest, so `/cli/*` always matches the hub.
- **Release signing:** no Apple notarization and no Windows Authenticode for the CLI itself, since Node is already signed by the Node project. The macOS and Windows signing jobs stay only for products that really are native binaries (e.g. cocalc-plus).

### Migration

- **The new installer takes over:** it replaces the SEA at `~/.local/bin/cocalc` with the launcher. Old SEA versions stay in `~/.local/share/cocalc/versions/` until `cocalc update --cleanup`.
- **The SEA pipeline keeps running** until the launcher has shipped and been verified on Linux x64/arm64, macOS arm64 and Windows x64. Then it's retired.

## Rollout

1. **Hub endpoints:** `/cli/install.sh`, `/cli/manifest.json` and `/cli/bundles/<sha256>.js` (unsigned at first, dev only), plus the installer and launcher. The setup scripts use them.
2. **Signing:** release key in CI, manifest signing, launcher verification, `cocalc update`, and the skew check with a clear message.
3. **Windows** launcher and installer.
4. **Retire the SEA** pipeline.
5. **Optional:** per-site bundles.

## Open questions

- **Node version.** Node 24 LTS or 26? `node:sqlite` stability matters, and projects run Node 26 today.
- **Release key custody.** The protected GitHub environment is enough to start; KMS later?
- **How hubs serve bundles.** Always from their own build, or redirect to R2? Both are edge-cached because the URLs are content-addressed.
- **The `cocalc plus` and `cocalc launchpad` subcommands** install other products. Do they keep their own native pipelines?
