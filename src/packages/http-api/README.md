# @cocalc/http-api

Standalone home for CoCalc's HTTP API handlers and Express router.

This package is the extracted home for CoCalc's actively supported HTTP API.
It preserves the existing `lib/*` and `pages/api/v2/*` layout so the current
`v2` handlers can move without a behavioral rewrite, while letting the hub and
launchpad mount `api/v2` directly without any Next.js dependency.

`pages/api/v2/*` contains the HTTP handlers. By default, the router discovers
handlers from that filesystem layout. Explicit route options, an embedded or
configured route bundle, or the Launchpad route set can take precedence; see
`lib/router.ts` for selection order. A filesystem edit therefore does not by
itself prove that a running bundled deployment exposes that route.
