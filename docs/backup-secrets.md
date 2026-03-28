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

- A **master key** is stored on disk at:
  - `DATA/secrets/backup-master-key`
  - This file is created automatically if missing (similar to `conat-password`).
  - The key is **not** stored in the database.
  - In Kubernetes, the file should be mounted from a secret.

- Hosted shared repos have one random secret per repo stored in Postgres:
  - Table: `project_backup_repos`
  - Column: `secret`
  - Format: `v1:<iv_b64>:<tag_b64>:<cipher_b64>` (AES-256-GCM)

- When a project host requests backup configuration:
  - The control plane resolves the assigned repo row.
  - It decrypts that repo secret using the master key.
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

- The master key file must be backed up securely; losing it makes **all**
  encrypted backup secrets unrecoverable.
- For local dev, the file is generated automatically.
- For production, treat the master key like any other high-value secret.
