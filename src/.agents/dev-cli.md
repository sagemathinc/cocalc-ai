# CoCalc Dev CLI Wishlist

This document tracks the highest-value developer-mode CLI improvements for working on CoCalc Lite, Launchpad, project-hosts, projects, frontend bundles, and public app routing.

The main theme is reducing ambiguity:

- what code changed
- what component needs rebuilding
- what version is actually running
- how a URL is routed in production
- how to run a realistic smoke test quickly

## Top 3 Most Valuable Improvements

1. Sync/deploy the exact changed runtime layer.
2. Show what code and bundle version is actually running.
3. Trace a public app URL end-to-end.

## Related Local Bridge Roadmap

There is a closely related category of local-machine features that should reuse
existing work instead of being reimplemented from scratch:

- SSH port forwarding for managed apps and native/X11 launches
- lightweight bidirectional file sync between a local directory and a project

The right implementation substrate is likely
[`reflect-sync`](/home/wstein/build/reflect-sync), which already has robust
port-forward lifecycle management, daemon support, and limited bidirectional
sync.  There is also already precedent in
[`src/packages/plus`](/home/wstein/build/cocalc-lite/src/packages/plus), where
CoCalc Plus exposes a UI on top of a small curated subset of `reflect-sync`
instead of all of its raw options.

That same product decision should apply in CoCalc proper:

- do **not** expose the full `reflect-sync` surface area
- do expose a small opinionated subset that is easy to explain and support
- keep the daemon-mediated UX and lifecycle management

Initial narrow scope:

1. `cocalc project app forward ...`
   - a curated SSH port forward for an app or raw port
   - later optionally mediated by the local CoCalc daemon
2. `cocalc sync ...`
   - a simple bidirectional sync command for a local directory and a project
   - conservative defaults, explicit conflict behavior, and no attempt to
     surface every advanced `reflect-sync` knob

This is out of scope for the current app-server project, but it is important
context because the same local daemon / SSH plumbing will likely be shared.

## Build Identity Plan

We need three different identities, not one overloaded "version":

1. Release version
   - user-facing `package.json` version
   - useful for published releases and compatibility policy
2. Source identity
   - git commit
   - dirty flag
   - ideally a dirty diff hash in dev mode
3. Build/runtime identity
   - generated per artifact/bundle at build time
   - what should answer "what is actually running?"

### Immediate rollout plan

1. Add a shared `BuildIdentity` type and generator utility.
2. Generate build identity metadata for:
   - project-host bundle
   - project bundle
   - tools
   - static/frontend
3. Surface active build ids in runtime status:
   - host rows
   - hub runtime info
   - project/runtime info
   - frontend/browser session metadata
4. Switch dev CLI reporting to prefer build ids over package versions wherever possible.

### Proposed build id format

Human-readable string form:

```text
20260306T220159Z-907b99d54138-dirty-a1b2c3d4
```

Where:

- timestamp gives rough monotonic ordering
- short git commit identifies the source base
- `dirty` distinguishes uncommitted builds
- optional dirty diff hash distinguishes two different dirty trees on the same commit

### Definition of done for the first useful milestone

- `cocalc dev sync project-host` and `cocalc dev sync project` print the deployed build id.
- `cocalc dev runtime versions` reports local source identity plus local/live artifact build ids.
- frontend/browser state exposes the frontend build id being served, so stale static builds are obvious.

## 1. Targeted Sync and Deploy

### `cocalc dev sync project-host`

One command should:

- build the correct project-host bundle
- copy it to the live host
- switch the active `current` symlink or equivalent
- restart the project-host cleanly
- report the exact deployed path, version, and host id

This removes the current friction around manually rebuilding, upgrading, and verifying which bundle is active.

### `cocalc dev sync project --project <id>`

One command should:

- rebuild the project-side software/runtime layer
- push or activate it for the target project
- restart only what is necessary
- confirm the project is now using the new version

This is especially important when debugging managed apps, since restarting only the hub is often not enough.

## 2. Runtime Introspection

### `cocalc dev runtime versions`

This should answer "what code is actually running right now?" and include:

- local git commit / branch / dirty state
- hub bundle version and live path
- project-host bundle version and live path
- project runtime version
- frontend asset build id / hash

Ideally it should also clearly flag mismatches, e.g.:

- local code changed but hub still old
- hub updated but project still old
- frontend rebuilt locally but browser still serving stale assets

## 3. Topology-Aware Restart Commands

### Examples

```bash
cocalc dev restart hub --wait
cocalc dev restart project-host <host-id> --wait
cocalc dev restart project <project-id> --wait
```

These should:

- understand dependencies and health checks
- wait for readiness when requested
- show what URL / process / service is being checked
- avoid unnecessary restarts of unrelated components

## 4. Explicit Upgrade Commands for Launchpad

### `cocalc admin host upgrade-software <host-id> --artifact project-host`

There should be a first-class command for upgrading software on a live host without manual file copying or symlink surgery.

This should support:

- choosing the artifact being upgraded
- showing the source bundle and target path
- dry-run mode
- rollback help if activation fails

## 5. URL Route Tracing

### `cocalc dev trace-url <url>`

This should show the full path a request takes through the system, e.g.:

- DNS target
- Cloudflare hostname / tunnel / subdomain
- hub rewrite behavior
- project-host target
- project id
- app id
- effective base path
- HTTP port / upstream target

This is particularly valuable for debugging public apps, `proxy` vs `port`, and Cloudflare routing.

## 6. Better Live Logs

### Examples

```bash
cocalc dev logs hub --grep public-app
cocalc dev logs project-host <host-id> --grep websocket
cocalc dev logs project <project-id> --app jupyterlab
```

The CLI should support:

- structured filtering
- tail/follow mode
- time ranges
- app-aware filters
- automatic Buffer-to-text decoding

The last point matters because raw JSON-serialized Node Buffers are painful to use during debugging.

## 7. First-Class Smoke Commands

### Examples

```bash
cocalc dev smoke app-public --project <id> --app code-server
cocalc dev smoke app-public --project <id> --app jupyterlab
cocalc dev smoke app-static --project <id>
```

These should exercise real workflows, not just API calls.  Ideally they include:

- HTTP probes
- websocket checks
- browser console error checks
- screenshot capture on failure
- cleanup / rollback support

## 8. App Inspection

### `cocalc project app inspect --project <id> <app-id>`

This should display the effective app state in one place:

- raw spec
- normalized spec
- exposure state
- computed public URL
- local/private URL
- current port
- resolved `APP_BASE_URL`
- recent stdout/stderr
- readiness / health result

This is particularly useful for understanding why a managed app is behaving differently in private vs public mode.

## 9. Dirty-State and Rebuild Guidance

Dev deploy commands should help answer:

- which packages changed
- which components need rebuild vs restart
- whether the target host/project is still running stale code

For example, after editing code the CLI should be able to say:

- this change requires frontend rebuild
- this change requires hub restart
- this change requires project-host upgrade
- this project still has old project runtime code

## 10. Browser Debugging Integration

### `cocalc dev browser-check <url>`

This should gather browser-side diagnostics in one shot:

- console errors
- failed network requests
- websocket handshake status
- screenshot
- maybe a HAR-like summary

This would be very useful for app routing and public-app debugging.

## 11. Public App Diagnose Command

### `cocalc project app diagnose-public --project <id> <app-id>`

This should run a deep public-app sanity check and report:

- DB reservation row
- DNS record state
- Cloudflare target
- hub rewrite
- project-host auth handoff
- project app state
- final HTTP probe
- final websocket probe

This is one of the highest-value commands for launchpad app development.

## 12. Design Principles for Dev Commands

Developer-mode commands should aim for:

- one obvious command per debugging task
- explicit statements of what is running where
- zero ambiguity about bundle/version drift
- machine-readable output via `--json`
- human-readable explanations by default
- strong support for partial deployment workflows

## 13. Suggested Order of Implementation

1. `cocalc dev sync ...`
2. `cocalc dev runtime versions`
3. `cocalc dev trace-url`
4. `cocalc dev logs ...`
5. `cocalc project app inspect`
6. `cocalc project app diagnose-public`
7. richer `cocalc dev smoke ...`
8. `cocalc dev browser-check`

This ordering would remove most of the friction encountered while debugging public app routing, websocket failures, bundle drift, and launchpad deployment issues.
