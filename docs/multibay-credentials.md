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
connection and cross-bay RPCs. Delete the temporary output file after the
installed credential has been verified. Then revoke the old credential:

```sh
pnpm --dir packages/server bay-credential revoke \
  --credential-id OLD_CREDENTIAL_ID
```

Issuing a replacement does not revoke the previous credential, so an
interrupted rotation can be resumed. Revocation prevents reconnect immediately.
Every publish and subscription rechecks registry status with a bounded timeout.
The seed also checks live bay sockets in parallel every five seconds and
disconnects revoked connections. A registry error fails closed: the operation
is denied and the sweep disconnects all bay-credential connections.

`bay-cluster.sh install-topology` creates distinct credentials, installs only
the owning bay's raw file on each machine, and installs a digest-only bootstrap
manifest on the seed through a mode-0700 remotely created temporary directory.
The seed validates existing ID/bay/digest bindings transactionally, imports the
manifest once, records completion, and deletes it. Running seed workers watch
the enrollment path, so adding a bay does not require a restart; the first
installation must use `--restart-hub-workers` if workers do not yet watch that
path. A revoked credential or conflicting ID is never restored by replay.

Attached bays require the explicit HTTPS seed CoCalc base URL; do not append
`/conat`, since the client adds that socket path. The generic seed Conat
password is not copied to them. Local development uses loopback HTTP and creates
the same one-shot manifest in its per-bay state directories. Single-bay
installations continue to use their existing local Conat authentication.
`COCALC_CONAT_SHARED_SECRET` is a separate per-bay secret used only for links
between Conat nodes inside that bay; it must not be shared between bays or
reused as a generic hub password.
