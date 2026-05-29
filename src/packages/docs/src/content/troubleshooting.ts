/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const MEMORY_TROUBLESHOOTING_BODY = String.raw`
## What low memory means

Low memory means the project is close to its RAM limit. Out-of-memory means the
Linux kernel killed a process because the project used more memory than the host
allowed. In notebooks, this often looks like a kernel restart, missing output,
or a cell that stops without finishing.

The limit is shared by everything running in the project: notebooks, terminals,
language servers, background jobs, web apps, databases, and agents.

## First things to try

1. Open the project process or activity view and stop work you do not need.
2. Restart the notebook kernel or terminal process that is using too much RAM.
3. Close idle notebooks, terminals, and servers.
4. Load less data at once, stream data in chunks, or write intermediate results
   to files.
5. Avoid keeping duplicate large arrays, dataframes, models, or images in
   memory.

For Python notebooks, clear variables you no longer need, restart the kernel
after large experiments, and prefer chunked data tools when datasets approach
the available RAM.

## When the workload really needs more memory

If the computation genuinely needs more RAM, move the project to a host or plan
with more memory. For repeated workloads, choose a project host with enough RAM
and disk for the largest expected dataset and runtime image.

If the project is on a shared host, remember that other work on the same host
can compete for memory. A dedicated host or larger host is more predictable for
large research jobs, courses, or agent sandboxes.

## Prevent repeat failures

Keep setup and data-processing steps reproducible so a killed process is not a
lost result. Save intermediate files, checkpoint long calculations, and use
scripts or notebooks that can restart from a durable point.

For agents, ask them to inspect memory usage before starting a large job and to
prefer incremental processing when the input data is large.

## Why this matters in CoCalc

CoCalc keeps notebooks and terminals durable, but it cannot make a process use
less RAM than the host provides. Treat memory as part of the project
environment: monitor it, size the host appropriately, and design workflows that
can recover after a process is killed.
`;

export const CONNECTIVITY_TROUBLESHOOTING_BODY = String.raw`
## What connectivity trouble looks like

CoCalc keeps a live connection between your browser and the service so files,
terminals, notebooks, chat, and project state stay synchronized. Connectivity
trouble usually appears as a sign-in prompt that never completes, reconnect
messages, stale project state, failed websocket connections, or editors that do
not update.

## First things to try

1. Refresh the browser tab.
2. Sign out and sign back in if the page says you are not authenticated.
3. Open CoCalc in a private browser window to rule out stale site data or a
   browser extension.
4. Disable privacy, ad-blocking, or script-blocking extensions for the CoCalc
   site.
5. Try another network if you are behind a strict firewall, campus proxy, VPN,
   or corporate security filter.

If the same browser has been used across several local development servers or
site hostnames, clearing site data for that hostname can fix stale localStorage
or cookie state.

## Network requirements

CoCalc needs normal HTTPS traffic and websocket connections to the site you are
using. Some proxies allow web pages but block websocket upgrades; that can make
the page load while realtime project features fail.

For a local development instance, make sure the browser is using the same
localhost port, session, and site hostname as the running server. If you switch
between Lite, hub, and project-host development environments, refresh the
matching development environment before using browser automation or CLI tools.

## What to include in a support report

When reporting a connectivity problem, include:

1. The exact site URL.
2. The browser and operating system.
3. Whether the problem happens in a private browser window.
4. Whether another network works.
5. Any visible reconnect message or browser console websocket error.
6. The approximate time the issue happened.

Do not include passwords, API keys, project secrets, or private tokens in a
support report.

## Why this matters in CoCalc

CoCalc projects are live collaborative workspaces. A partial connection can be
more confusing than a fully offline page because some UI may render while the
realtime project connection is blocked. The fastest diagnosis is to separate
browser state, authentication state, and network websocket access.
`;
