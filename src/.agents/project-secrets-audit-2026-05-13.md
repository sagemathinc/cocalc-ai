# Project Secrets Security Audit - 2026-05-13

## Scope

This pass reviewed the first project-secrets implementation against the main leak paths that would defeat the feature's defense-in-depth goals:

- project filesystem backups and backup restore;
- file downloads, archive creation, public sharing, and filesystem RPC paths;
- rootfs publication;
- runtime container mounts and cleanup;
- multi-bay copy and clone flows;
- logging of runtime project configuration.

## Findings

Project secrets are not stored inside the project home tree. The project runner writes them to a host runtime directory under `/tmp/cocalc-project-secrets/<project_id>` with a private parent directory, private project directory, and `0400` secret files, then mounts that directory read-only into the container at `/run/secrets/cocalc`.

The stable in-container access path is exposed as `COCALC_SECRETS=/run/secrets/cocalc`. Project backup, rootfs publication, downloads, archive creation, and public sharing operate on project home/rootfs/scratch paths, not this host runtime directory.

The file-server sandbox policy does not expose `/run/secrets/cocalc` through project file operations. This is now covered explicitly in `file-server-sandbox-policy.test.ts`.

The audit found one concrete bug: `project-runner:podman` logged the start configuration with `secret` redacted, but not `secrets`. That could expose project secret values in debug logs. The start config logging now redacts both the legacy `secret` token and every value in `secrets`, preserving only secret names for diagnostics.

The multi-bay secret-copy path is hub-routed by project ownership. Same-bay copies execute on the owning bay; cross-bay copies export decrypted values from the source bay and import them to the target bay through the inter-bay bridge after collaborator checks on both projects. Clone creation copies project secrets after the filesystem clone and before the new project is registered with the host; failures delete the new project row and abort the clone.

## Residual Risks

Any code running inside the project can read mounted secrets. This is intentional and must remain clear in UI and docs.

The project-host temporarily has decrypted secret values in memory while starting a project and writes plaintext files into a private host runtime directory. This is acceptable for the current runtime model, but it means host root or a compromised project-host process can read secrets.

The mounted secret files are static for the lifetime of a running container. Users must restart the project after set, delete, or copy operations for the runtime mount to reflect changes.

## Validation Added

- `project-runner/run/podman.test.ts` verifies log redaction for both `secret` and `secrets`.
- `project-host/file-server-sandbox-policy.test.ts` verifies project file-server paths cannot read or write `/run/secrets/cocalc/...`.
