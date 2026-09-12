# Backup Repo Secrets and Key Management

This document describes how backup secrets are generated, stored, and used for
Rustic repositories. It also outlines current semantics for hosted shared repos
and future key rotation.

## Goals

- Shared Rustic repos have encrypted passwords stored in Postgres.
- Secrets are not stored in plaintext in the database.
- A database leak alone does not expose backup passwords.
- Key rotation remains possible without breaking restore.

## Current Design

- The backup encryption key is derived from the **site master key**, using the
  purpose `project-backup-repo-secrets:v1`. The default site key is
  `${SECRETS}/site-master-key` (`${DATA}/secrets/site-master-key` unless the
  secrets directory is overridden). See [Secrets](./secrets.md) for path
  overrides, systemd credentials, and required-key behavior.
- `${SECRETS}/backup-master-key` is a **legacy** decryption key. Existing
  repository secrets that need it are decrypted and re-encrypted with the
  derived site key on read. Preserve legacy keys while retained databases or
  unmigrated rows still depend on them.
- The site master key is not stored in Postgres. Provision and back it up
  separately from the database.

- Hosted shared repos have one random secret per repo stored in Postgres:
  - Table: `project_backup_repos`
  - Column: `secret`
  - Format: `v1:<iv_b64>:<tag_b64>:<cipher_b64>` (AES-256-GCM)

- When a project host requests backup configuration:
  - The control plane resolves the assigned repo row.
  - It decrypts that repo secret using the purpose-derived key, with legacy-key migration when needed.
  - The secret is embedded into the Rustic TOML.

### Security Properties

- **DB leak only**: secrets remain encrypted without the master key.
- **Master key leak only**: no secrets to decrypt without DB data.
- **Both leaked**: secrets are exposed (as with any envelope-encryption design).

### Deletion Semantics

- For shared repos, deleting one project's data means forgetting that project's
  snapshots, not deleting the repo secret.
- Deleting a shared repo secret would affect every project assigned to that repo,
  so it is not a per-project deletion mechanism.

## Rotation Plan (Future)

The keyring below is an earlier proposal, not the implemented site-master-key
lifecycle or an operator rotation command. The current stored repository-secret
format is still `v1`; do not replace a live key based on this example.

Rotation is intended to decouple:

- **DB backup retention** (how long old DB snapshots exist)
- **Project deletion guarantees** (when data is irrecoverable)

Recommended approach:

1. Move to a **keyring** file:
   - Example format:
     ```
     {
       "active": "k2026-01-01",
       "keys": {
         "k2026-01-01": "<base64>",
         "k2025-10-01": "<base64>"
       }
     }
     ```
2. Update the encrypted secret format to include a key id:
   - `v2:<kid>:<iv_b64>:<tag_b64>:<cipher_b64>`
3. On read:
   - Select the correct key from the keyring.
4. On write:
   - Always encrypt using the active key.
5. Rotation procedure:
   - Add a new active key.
   - Optionally rewrap all secrets in the background.
   - Keep old keys until all DB backups older than the rotation are expired.
   - Remove old keys once safe.

This enables controlled key rotation while keeping restore compatibility for
shared repos.

## Operational Notes

- Back up the site key and any legacy keys still needed by retained database
  versions. Losing a key makes ciphertext that depends on it unrecoverable
  unless another valid copy of that key is available.
- For local development, a missing site key is generated only when it is not required or supplied as a read-only credential.
- For production, treat the master key like any other high-value secret.
