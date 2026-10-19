# Private security fixes: from private repo to prod to public

Security fixes are developed in the private repo `sagemathinc/cocalc-ai-private` until they are live on prod, then disclosed in the public repo `sagemathinc/cocalc-ai`.

The private repo is a separate repository, not a fork: an ordinary fork of a public repo must be public. GitHub's one exception, the temporary private fork of a security advisory, holds one fix at a time and doesn't run GitHub Actions. The commits are the same in both repos: everything moves between them as plain git pushes of the same SHAs. A draft security advisory can still track a report, credit the reporter and request a CVE (see `SECURITY.md`).

## Rules

- **Public main is the source of truth.** Private `main` only mirrors it. Nobody commits to private `main`; `private-fix.sh sync-main` fast-forwards it, and refuses if it has diverged.
- **Private work lives only on `security/*` branches** in the private repo, and they start from public main. CI, @review and codex review run on the private PRs.
- **Nothing private is pushed to the public repo before it is on prod.** `pre-push-guard.sh` enforces this in every worktree (see Setup).
- **Disclose promptly after prod.** cocalc-star and other self-hosted installs are built from the public repo, so they only get a fix once it is disclosed.

## Flow

1. **Start a release's integration branch:** `private-fix.sh integration <release-name>` creates `security/<release-name>` from public main in the private repo.
2. **Each fix:** run `private-fix.sh start <topic>`, commit, push to the private URL, then open a private PR against the integration branch. Get @review and codex on the final head, then William's approval, then merge.
3. **Release:** the release branch is public main (or the release commit) with the integration branch merged in. Build, test on staging (including a manual browser check where relevant), get sign-off, and deploy prod. The release branch is never pushed to the public repo.
4. **Disclose after prod:**
   1. Run `disclose.sh <release-branch-tip> <name> --release <id>` to check what would be published.
   2. Re-run it with `--yes` to push the exact deployed commits to `disclose/<name>` and open the public PR. That push is the disclosure: the commits are public from then on.
   3. Once public CI passes, William merges it.
   4. Delete the private `security/*` branches. Private `main` catches up at the next `sync-main`.
5. **Optional:** publish a GitHub security advisory that credits the reporter.

## Setup (once per clone)

```sh
src/scripts/security/install-hooks.sh
```

This installs the push guard in the clone's common git directory, so it covers every worktree of the clone. The installer:

- refuses if `core.hooksPath` is set, because Git would then ignore that directory;
- only ever replaces a hook it installed itself.

The guard allows any push to a known private repo. These are:

- `sagemathinc/cocalc-ai-private`, `sagemathinc/cocalc-ai-content-security` and advisory forks `sagemathinc/cocalc-ai-ghsa-xxxx-xxxx-xxxx`, in the supported GitHub forms only:
  - `git@github.com:…`;
  - `ssh://git@github.com[:22]/…`;
  - `ssh://git@ssh.github.com:443/…`;
  - `https://github.com/…`.
- any URL exactly equal to a `git config --add cocalc.privateUrl <url>` value. There is no URL normalization, so a different user, port, suffix or scheme is not trusted.

Other `cocalc-ai-*` repos are not trusted; `cocalc-ai-doc`, for example, is public. For every other destination (the public repo, forks, other hosts, local paths) the guard refuses:

- a source or destination branch named `security/*`, `ghsa*` or `release/*security*`;
- a commit that is on a private branch but on no branch of the public repo. Private branches are those of the private repo, of other private remotes, and local or remote-tracking branches with private names (even for a remote without a URL);
- rewritten private work: cherry-picks, amends, rebases, and squashes of several commits onto a newer base. These are commits with the same tree or the same patch-id (`git patch-id --stable`) as a private commit, or a commit or pushed branch whose patch-id equals a private branch's combined change since it forked from public main. Content already public as an individual public commit (same tree or same patch-id), under another commit id, doesn't count. Combined ranges of public branches are not compared, so a squash whose combined change matches only a public multi-commit series is refused, conservatively. A partial cherry-pick (only some hunks) or a hand-retyped change is not detected;
- anything that isn't a commit: blobs and trees pushed directly, and annotated tag objects. A tag message is new content that could describe an undisclosed vulnerability, even for a tag of a public commit. Lightweight tags of commits are fine.

Pushes that only delete branches are always allowed, with no analysis.

On every such push it fetches all of these branch lists fresh, in parallel: the private repo's, every private remote's, every `cocalc.privateUrl` repo's, and the public repo's. That takes 2–4 seconds. The guard never touches your `FETCH_HEAD`.

- If any of those fetches fails and the clone has private work, the guard refuses the push (fail closed). Private work means a private remote, a `cocalc.privateUrl`, a private-named branch, or refs cached by an earlier run.
- When a private repo is deleted, for example a published advisory fork, run `private-fix.sh retire-remote <name>`. It keeps that remote's commits under `refs/cocalc-guard/retired/` as permanently private, then removes the remote.

`COCALC_DISCLOSE=1`, set by `disclose.sh`, allows the deliberate disclosure push. Keep the `private` remote's push URL disabled; the scripts push to its explicit URL.

## What the guard does and doesn't promise

It protects against **accidental** publication of private work.

**Hard guarantees:** pushes to non-private destinations are refused for:

- private branch names;
- any private commit id;
- non-commit objects;
- pushes made when private state can't be fetched, archived or analyzed (fail closed).

**Best-effort detection:** private work rewritten with git (cherry-pick, amend, rebase, squash, re-split by file onto another public base) is refused when its tree or patch-id matches private work.

**Out of scope:** deliberate evasion, such as retyping the code by hand, copying only some hunks, or mixing private hunks with new edits in the same commit. Treat the guard as a seatbelt, not as access control: anyone who can read the private repo can publish its contents.

`pre-push-guard.test.sh` tests the guard and the installer in a temporary directory, with local stand-in repos. It needs no network and doesn't touch your branches.
