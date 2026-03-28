# @cocalc/http-api

Standalone home for CoCalc's HTTP API handlers and Express router.

This package is the extracted home for CoCalc's actively supported HTTP API.
It preserves the existing `lib/*` and `pages/api/v2/*` layout so the current
`v2` handlers can move without a behavioral rewrite, while letting the hub and
launchpad mount `api/v2` directly without any Next.js dependency.
