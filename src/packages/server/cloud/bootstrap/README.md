# Bootstrap Python Publisher

`bootstrap.py` is served to project hosts during bootstrap. It is now published
to the software bucket so updates don't require rebuilding the hub bundle.

Preferred deploy path (from repo root). Replace the quoted tag and profile
placeholders with the intended artifact tag and configured site profile:

```
cocalc software deploy --build "host-bootstrap:<tag>" "<profile>"
cocalc software deploy --build --rollout --bootstrap-scope helpers "host-bootstrap:<tag>" "<profile>"
```

Both commands publish an immutable artifact and update the target fleet's
desired bootstrap version, including asking all hosts to resume the default bootstrap policy. Only the command with `--rollout` also
requests an immediate reconcile of online hosts; recording desired state is
not proof that every host has applied it. Neither command infers a mutable
publication channel from the site profile. To intentionally update one, add
`--bootstrap-publish-channel staging` or `--bootstrap-publish-channel latest`.

With `--rollout`, the reconcile scope is mandatory; without `--rollout`,
`--bootstrap-scope` is rejected:

- `helpers` updates privileged host helpers and their sudo policy and reconciles
  runtime policies. It does not request restarts of project-host, Conat, ACP,
  or project containers. When Cloudflared is enabled, this scope also installs
  a missing binary or upgrades a version mismatch. The Cloudflared service
  restarts when its package or configuration changes, or when it is inactive.
- `environment` writes the managed host environment and bootstrap state files
  without restarting the host daemons or project containers. Writing an
  environment file does not replace the environment of an already-running process.
- `full` runs the complete bootstrap reconcile and restarts project-host. Use
  it only when the changed bootstrap code requires full host convergence.

Low-level publish fallback:

```
pnpm --dir src/packages/server publish:bootstrap
```

Required env:

- `COCALC_R2_ACCOUNT_ID`
- `COCALC_R2_ACCESS_KEY_ID`
- `COCALC_R2_SECRET_ACCESS_KEY`
- `COCALC_R2_BUCKET`
- `COCALC_R2_PUBLIC_BASE_URL` (e.g., `https://software.cocalc.ai`)

Optional:

- `COCALC_BOOTSTRAP_SELECTOR` (default: `latest`)
- `COCALC_BOOTSTRAP_CACHE_CONTROL`

Publishes to:
`$COCALC_R2_PUBLIC_BASE_URL/software/bootstrap/<selector>/bootstrap.py`
and `bootstrap.py.sha256`.
