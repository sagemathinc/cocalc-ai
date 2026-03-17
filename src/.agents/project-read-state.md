# Project Read State Plan

## Goal

Add a project-scoped, account-scoped read-state abstraction backed by DKV so
chat and later other document types can track "what this user has read" without
writing patchflow history into the documents themselves.

This must be:

- synchronous to use after initialization
- compact on the wire and in memory
- shared across frontend, backend, CLI, and agents
- generic enough to support chat now and other document types later

## Core Design

- one DKV store per `(project_id, account_id)`
- one DKV key per document path
- value shape depends on document kind
- chat is the first supported kind

Initial chat value shape:

```ts
{
  kind: "chat",
  threads: {
    [thread_id]: { m: message_id, t: Date }
  }
}
```

This stores watermarks, not append-only read events.

## Why This Design

- Avoids patchflow churn in `.chat`
- Avoids one giant per-project blob where every write resends all chat state
- Keeps reads sync after DKV init
- Keeps total size proportional to distinct documents/threads, not read events
- Is directly useful to agents and CLI for "recent docs/threads"

## Package Placement

Create the abstraction in:

- `src/packages/conat/project/read-state.ts`

Reason:

- this is project-scoped user state
- it is not file metadata
- it should be usable from chat, notebooks, tasks, CLI, and agents

## Public API

Initial API:

```ts
openProjectReadState({
  client,
  project_id,
  account_id,
})

get(path)
set(path, value)
delete(path)
listEntries()
listRecent({ limit, kind? })

getChatThreads(path)
getChatThread(path, thread_id)
touchChatThread(path, thread_id, { message_id, at })
markChatThreadRead(path, thread_id, { message_id, at })
```

All methods should be synchronous after store init, matching normal DKV usage.

## Implementation Phases

### Phase 1: Core Module

1. Create `read-state.ts`
2. Define core types:
   - `ProjectReadStateEntry`
   - `ChatReadStateEntry`
   - future placeholder types for notebook/text/tasks
3. Define DKV naming:
   - `project-read-state-v1/<account_id>`
4. Implement:
   - `openProjectReadState(...)`
   - `get`
   - `set`
   - `delete`
   - `listEntries`
   - `listRecent`
5. Export it from the relevant `conat/project` barrel

### Phase 2: Chat Helpers

6. Add chat-specific helpers:
   - `getChatThreads`
   - `getChatThread`
   - `touchChatThread`
   - `markChatThreadRead`
7. Keep the chat value compact and stable
8. Add unit tests for the module

### Phase 3: Switch Chat

9. Replace the current patchflow/thread-config read markers in chat with this
   read-state store
10. Remove the old `read-*` writes into `.chat`
11. Keep unread/read checks using the new read-state abstraction only
12. Add integration tests proving chat read tracking no longer writes patchflow

### Phase 4: CLI / Agent Access

13. Add CLI support in `packages/cli`
14. Initial commands:

- `project read-state list`
- `project read-state recent`
- `project read-state get --path <path>`
- `project read-state chat-thread --path <chat> --thread-id <id>`

15. Make CLI read via the same abstraction, not a second implementation

### Phase 5: E2E Validation

16. Real end-to-end test with an agent:

- read a chat thread
- verify read-state persisted
- ask agent/CLI for recent docs/threads
- verify the recently used chat is returned

### Phase 6: Future Extension

17. Add support for other document kinds as needed
18. For long documents, support compact progress-style watermarks, e.g.:

```ts
{ p: patch_id, t: Date, cells: number }
```

Interpretation:

- the user has seen the document from the top through roughly this point

Do not implement this now, but keep the abstraction flexible enough for it.

## Success Criteria

1. Chat no longer writes `read-*` markers into `.chat` patchflow
2. Chat read/unread still works correctly
3. Read-state is sync to query after init
4. CLI and agents can query recent docs/threads through the shared abstraction
5. The API is generic enough to add notebook/text/tasks support later without
   redesigning the storage model
