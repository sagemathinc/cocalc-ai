# @cocalc/http-api

Standalone home for CoCalc's HTTP API handlers and Express router.

This package is the first extraction step away from Next.js. It preserves the
existing `lib/*` and `pages/api/v2/*` layout so the current `v2` handlers can
move without a behavioral rewrite, while letting the hub and launchpad mount
`api/v2` without importing that router from `@cocalc/next`.
