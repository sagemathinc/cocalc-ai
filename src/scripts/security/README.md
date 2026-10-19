# Private security fixes: from private repo to prod to public

Security fixes are developed in the private repo `sagemathinc/cocalc-ai-private` until they are live on prod, then disclosed in the public repo `sagemathinc/cocalc-ai`.

GitHub does not allow a private fork of a public repo, so the private repo is a separate repository with no fork link. The commits are the same, though: everything moves between the two repos as plain git pushes of the same SHAs.

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
   2. Re-run it with `--yes` to push the exact deployed commits to `disclose/<name>` and open the public PR.
   3. Once public CI passes, William merges it.
   4. Delete the private `security/*` branches. Private `main` catches up at the next `sync-main`.
5. **Optional:** publish a GitHub security advisory that credits the reporter.

## Setup (once per clone)

```sh
src/scripts/security/install-hooks.sh
```

This installs the push guard in the clone's common git directory, so it covers every worktree of the clone. The guard refuses pushes to the public repo of:

- branches named `security/*`, `ghsa*` or `release/*security*`;
- any commit that a private remote has and no public remote has.

Private remotes are any `sagemathinc/cocalc-ai-*` URL, including GHSA forks. The commit check only knows about commits that are in your fetched remote-tracking refs, so fetch the private remote before pushing. Keep the `private` remote's push URL disabled; the scripts push to its explicit URL.
