# Named-agent conversation search

The Agents sidebar has two separate controls: the existing name filter and
**Search conversations**, which opens Search all agents for saved conversation
messages. The name-only input is labeled **Filter agents by name**. Search uses
the existing project-routed chat-store API rather than a central content index.

## Scope and budgets

- Current threads are searched by default. Past conversations are opt-in and
  include the five most recent recorded historical threads per agent.
- Candidates are ordered by known agent activity, with identity update time as
  a fallback. An optional project filter narrows the candidate set.
- Each pass searches batches of 20, stopping after a batch produces at least
  40 hits, or at 100 agents, 150 thread requests, or 20 seconds.
- At most three projects are searched concurrently, with one request sequence
  per project. Timed-out sequences retain their capacity until they settle.
- Each thread returns at most 20 hits. Each pass retains the newest 100 hits.
  **Search more agents** continues with unattempted candidates, retaining the
  previous results. Thread search provides deeper inspection within a thread.
- Project running state is not a search prerequisite: the host reads saved files
  without starting the project. Offline hosts and inaccessible storage cannot
  be searched. Errors and timeouts are reported separately
  from successful searches with no matches. Coverage and partial-result notices
  remain visible.

The combined backend query reads a bounded saved `.chat` head (8 MiB maximum)
and merges it with the existing SQLite archive search, scoped to an exact
thread. Workers isolate SQLite work from the serving event loop; each process
admits at most three workers with a six-second timeout. Native SQLite work can
delay worker termination, so its slot is retained until termination completes.
Project and project-host bundles explicitly include the worker entry point.

## Navigation and state

Current results select the named agent and scroll to the message in Agents.
The search drawer stays open while inspecting current results. Clicking outside
it, pressing Escape, or using its close button dismisses it. Agent message URLs
carry a chat timestamp fragment and restore the selected message on load or
browser navigation. Explicit historical-thread fragments do not replace the
agent's active context.
Historical results open the corresponding project chat thread without changing
the named agent's active conversation. Archived hits are hydrated before
scrolling. A changed active thread produces an explicit stale-result error.

Drawer state is account-scoped outside the component. Query, filters, width,
results, progress, and scroll position survive unmount/remount. Session storage
retains preferences across reloads, but message excerpts/results stay in memory.
Search does not include artifacts or unsaved editor changes.
