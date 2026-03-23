# @cocalc/api-v2

Standalone home for CoCalc's HTTP `api/v2` handlers and Express router.

This package is the first extraction step away from Next.js. It preserves the
existing `lib/*` and `pages/api/v2/*` layout so the handlers can move without a
behavioral rewrite, while letting the hub and launchpad mount `api/v2` without
importing that router from `@cocalc/next`.
