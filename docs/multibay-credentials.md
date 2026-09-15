# Trusted Bay Credentials

Multibay hubs are trusted instances of one CoCalc application. Each bay uses a
different opaque credential so connections can be attributed and one bay can be
rotated without interrupting the rest of the cluster. These credentials do not
isolate a compromised hub from the site; distrust of a hub is a site incident.

The seed stores only credential digests in `cluster_bay_credentials`. Each hub
reads its raw credential from the mode-0600 file named by
`COCALC_BAY_CREDENTIAL_FILE`. A multibay fabric connection never falls back to
the shared hub password.

## Rotation

Run the credential command with the seed database environment loaded:

```sh
pnpm --dir packages/server bay-credential issue \
  --bay bay-1 \
  --replaces OLD_CREDENTIAL_ID \
  --output /absolute/secure/path/bay-1-credential.new
```

Install the resulting file as that bay's `COCALC_BAY_CREDENTIAL_FILE`, restart
only that bay's hub workers (for local development, use
`./src/scripts/dev/hub-daemon.sh restart-bay bay-1`), and verify its registry
connection and cross-bay RPCs. Then revoke the old credential:

```sh
pnpm --dir packages/server bay-credential revoke \
  --credential-id OLD_CREDENTIAL_ID
```

Issuing a replacement does not revoke the previous credential, so an
interrupted rotation can be resumed. Revocation prevents reconnect immediately.
The seed Conat server sweeps authenticated bay sockets every five seconds and
disconnects a revoked live connection; authorization checks also reject it on
its next publish or subscription.

`bay-cluster.sh install-topology` creates distinct credentials, installs only
the owning bay's raw file on each machine, and installs a digest-only bootstrap
manifest on the seed. The local development hub cluster does the equivalent in
its per-bay state directories. Single-bay installations continue to use their
existing local Conat authentication.
