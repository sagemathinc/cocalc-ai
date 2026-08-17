# cocalc.com migration router

This is the source for the Cloudflare Worker named
`cocalc-com-migration-router`, attached to `cocalc.com/*`.

The Worker keeps verified marketing routes and Cambridge content on their
dedicated permanent mappings. Unclassified historical paths are sent through
`https://cocalc.ai/legacy/...`, where CoCalc resolves legacy public-share slugs
and falls back to the corresponding current path when no share exists.

Run the focused tests with:

```sh
node --test src/scripts/cloudflare/cocalc-com-migration-router/worker.test.mjs
```

Deployments use the Cloudflare Workers Scripts API with account
`bf59ea74a28f5bf3c2679e78f6db1205`, script
`cocalc-com-migration-router`, main module `worker.mjs`, and compatibility date
`2026-07-26`. Always download and retain the currently deployed multipart
source before uploading a replacement, and smoke-test both legacy-share and
ordinary permanent paths immediately afterward.
