## Frontend Standby / Load Shedding Plan

Status: partially implemented as of 2026-04-17

### Goal

Replace the old frontend idle behavior:

- wait for idle timeout
- show warning
- disconnect everything

with a staged, coordinator-owned load-shedding protocol:

1. keep cheap account presence alive as long as possible
2. shed expensive project-local resources first
3. only later escalate to full standby

This is the same design direction we want on the server side for stopping
projects: staged reduction of load instead of a single blunt kill switch.

### What Landed

#### 1. Visible tabs no longer hard-standby just because there was no input

In [idle.ts](../packages/frontend/client/idle.ts):

- visible pages keep resetting idle
- passive viewing now counts as legitimate activity
- this directly addresses:
  - presentations
  - second-monitor viewing
  - dashboards / terminals / output people are watching

#### 2. `monitor-connection.ts` is less of a competing reconnect policy layer

In [monitor-connection.ts](../packages/frontend/app/monitor-connection.ts):

- fixed the broken heartbeat trimming bug
- stopped forcing its own `resetBackoff: true` reconnects
- it is now closer to a global observer / warning layer

#### 3. Standby timeout preference is gone from account settings

In [other-settings.tsx](../packages/frontend/account/other-settings.tsx)
and [init.ts](../packages/frontend/account/init.ts):

- the user-facing standby timeout control was removed
- frontend runtime no longer reads `other_settings.standby_timeout_m`
- the idle client now uses a fixed 30 minute default

Legacy account data may still contain the old field, but the product no
longer surfaces or uses it.

#### 4. First staged standby implementation landed

In [reconnect-coordinator.ts](../packages/frontend/conat/reconnect-coordinator.ts),
[client.ts](../packages/frontend/conat/client.ts), and
[idle.ts](../packages/frontend/client/idle.ts):

- added coordinator standby stages:
  - `active`
  - `soft`
  - `hard`
- soft standby suppresses reconnect work for registered resources
- soft standby keeps the main account / Conat transport alive
- soft standby sheds:
  - routed project-host connections
  - legacy project websocket connections
- hard standby still does the full Conat disconnect

Current hidden-idle behavior is now:

1. idle timeout expires
2. warning shows
3. after 15 seconds: enter soft standby
4. after an additional 5 minutes: escalate to hard standby

### Why This Is Better

This keeps:

- notifications
- account presence
- other cheap account-scoped state

alive longer, while hidden idle tabs stop pinning expensive project-local
connections open.

This is a product improvement even before every resource has a custom
soft-standby hook.

### Current Limitations

The current implementation still sheds project-local load mostly at the
Conat client layer by closing routed/project sockets from above.

That is useful, but it is not yet ideal.

What is still missing is resource-aware soft standby behavior for the
foreground-heavy resources that already participate in reconnect:

- terminals
- editors / syncdocs
- notebooks
- Codex activity log

Those resources currently reconnect through the coordinator, but they do
not yet register explicit "soft standby" actions.

### Best Next Steps

#### 1. Dogfood this exact state for another day

Use alpha aggressively with:

- many tabs
- many chats / Codex turns
- passive hidden tabs
- laptop sleep / resume
- second-monitor / visible passive viewing

Primary question:

- does the new soft-then-hard standby path feel invisible when things are
  working normally?

Secondary question:

- does it materially reduce hidden-tab resource pressure without killing
  notifications/presence too early?

#### 2. Add resource-specific soft-standby hooks

Best order:

1. terminals
2. editors / syncdocs
3. notebooks
4. Codex activity log

The coordinator should orchestrate this, not `idle.ts`.

Desired shape:

- extend reconnect resource registration with optional soft-standby hooks
- coordinator calls those hooks when entering soft standby
- coordinator triggers normal reconnect recovery on resume

#### 3. Keep cheap account streams alive until hard standby

This should remain true by design:

- account feed
- badges / notifications
- lightweight browser-session/account presence

If we find any of those getting shut down during soft standby, that is a bug.

#### 4. Later: align server-side project stopping with the same philosophy

Longer term, project stopping should mirror the same staged approach:

- reduce load first
- release expensive resources incrementally
- only stop the whole project as the final step

That work is separate, but the frontend standby redesign is the right
client-side precedent.

### Concrete Tomorrow Slice

If the current dogfood signal remains good, do this next:

1. add coordinator soft-standby hooks to terminals
2. then add them to editor syncdocs / notebooks

That is the cleanest continuation of what already landed.
