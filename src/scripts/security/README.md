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

This installs the push guard in the clone's common git directory, so it covers every worktree of the clone. It refuses to run if `core.hooksPath` is set, since Git would then ignore that directory. The guard allows any push to a private repo (`github.com/sagemathinc/cocalc-ai-<name>`, in any URL form). For every other destination (the public repo, forks, other hosts, local paths) it refuses:

- a source or destination branch named `security/*`, `ghsa*` or `release/*security*`;
- a commit that is on a private branch but not in public main or on a public `disclose/*` branch. Private branches are those of the private repo, of other configured `sagemathinc/cocalc-ai-*` remotes, and local branches with private names.

It fetches the private and public branch lists fresh on every such push, and fails closed if it can't when the clone has private work. `COCALC_DISCLOSE=1`, set by `disclose.sh`, allows the deliberate disclosure push. Keep the `private` remote's push URL disabled; the scripts push to its explicit URL.

`pre-push-guard.test.sh` exercises the guard without pushing anything. It needs access to the private repo.
