# Admin Settings Cleanup

## Cleanup

- [ ] \(in progress elsewhere\) Public share server and GitHub proxy settings are still configurable even though share\-server is being deprecated for XSS risk; these settings could re\-enable insecure paths. [`src/packages/util/db-schema/site-defaults.ts#L668`](./src/packages/util/db-schema/site-defaults.ts#L668), [`src/packages/util/db-schema/site-settings-extras.ts#L567`](./src/packages/util/db-schema/site-settings-extras.ts#L567)
- [x] sameSite cookie setting can be set to `none`, which removes a CSRF defense; consider removing or hiding unless explicitly in a safe on\-prem dev mode. [`src/packages/util/db-schema/site-defaults.ts#L826`](./src/packages/util/db-schema/site-defaults.ts#L826)
- [x] Prometheus metrics can be exposed at `/metrics` without any mention of auth/IP allow\-listing, which could leak internal data if publicly reachable. [`src/packages/util/db-schema/site-settings-extras.ts#L724`](./src/packages/util/db-schema/site-settings-extras.ts#L724)
- [x] Pay\-as\-you\-go settings remain in admin UI \(some marked “NOT CURRENTLY USED”\), which is confusing now that PAYG is deprecated and could lead to misconfiguration. [`src/packages/util/db-schema/site-settings-extras.ts#L731`](./src/packages/util/db-schema/site-settings-extras.ts#L731)
- [x] PII retention defaults to “never,” which can violate compliance expectations unless explicitly intended. [`src/packages/util/db-schema/site-settings-extras.ts#L409`](./src/packages/util/db-schema/site-settings-extras.ts#L409)
- [x] Private keys stored in DB via settings \(software license signing \+ control plane SSH\). If the DB isn’t encrypted/locked down, this is a sensitive\-secret risk; consider file\-only or secret manager. [`src/packages/util/db-schema/site-settings-extras.ts#L296`](./src/packages/util/db-schema/site-settings-extras.ts#L296), [`src/packages/util/db-schema/site-settings-extras.ts#L822`](./src/packages/util/db-schema/site-settings-extras.ts#L822)

## Secret Settings Hardening (Plan)

- [ ] Define which admin settings are secrets. Treat all settings with `password: true` as secret, and add an explicit `secret: true` flag for any non-password secrets. Add a helper `isSecretSetting(name)` in `@cocalc/util` so both backend and frontend can share the same list.
- [ ] Add a small encryption helper in `@cocalc/util` that supports `encryptSecret`/`decryptSecret`, using AEAD (AES-256-GCM or XChaCha20-Poly1305) with a versioned prefix like `enc:v1:<key-id>:<nonce>:<ciphertext>`. Include `name` as associated data to prevent swapping values between fields.
- [ ] Introduce a master key file path (env override, e.g., `COCALC_SECRET_SETTINGS_KEY_PATH`; default under `$COCALC_ROOT/data/secrets/`). On startup, create the key if missing (0600 perms). In k8s, mount a secret at this path.
- [ ] Encrypt on write: update `set_server_setting` to encrypt secrets before storing in `server_settings`. Also cover `load_server_settings_from_env` so env-provided secrets get encrypted too.
- [ ] Decrypt on internal read: ensure `getServerSettings` decrypts secrets for server use. Add a one-time migration path: if a secret value is plaintext, encrypt it and write back (keeping backward compatibility for existing installs).
- [ ] Make secrets write-only in the admin UI: do not return secret values to clients. Instead return `is_set` metadata and render inputs as “Set”/“Update” only. Update the `site_settings` query handler and the admin settings UI to avoid echoing secrets in confirmation dialogs.
- [ ] Add basic audit logging for secret setting changes (name, actor, timestamp), without logging the value.
- [ ] Tests: unit tests for encryption round-trip and masking, plus an integration check that secret values are not returned from the `site_settings` query.

