# Chat

## Current cache and compatibility readers

- Chat data now lives in a single source of truth: the SyncDoc backed by Patchflow/Immer. `message-cache.ts` listens to SyncDoc change events and exposes plain JS message maps plus thread metadata indexes. Thread config is keyed by `thread_id`; legacy date-key indexes remain only for compatibility with older helpers and root-message lookups. Messages are stored as the raw frozen syncdb objects to avoid extra copies.
- `normalizeChatMessage` returns a shallow normalized copy for compatibility consumers. It can supply legacy identity fields, coerce dates, and convert old payload fields. The current cache and sync readers do not write that copy back merely because normalization ran; reading is not a file migration.
- The Redux store still uses immutable.js for unrelated UI state, but chat messages themselves are plain JS objects served from the cache/context.

## Timestamps

- Message dates are stored as ISO strings. Cache records can retain those strings; compatibility readers can return `Date` values. Use helpers such as `dateValue` instead of assuming every cached date is a `Date`.
- Legacy thread/message date keys use the millisecond timestamp as a string (e.g., `"1733958748000"`). New thread metadata/config lookups should prefer `thread_id` and only fall back to date keys when working with root-message compatibility paths.

## Overview

CoCalc has two chat views.

- Side chat associated with files
- Primary chat rooms \(also a file\)

The constricting factors are primarily keyboard related or screen size related.
ie., you cannot use certain hotkeys without a physical keyboard and certain things don't fit well on a smaller screen.

## Historical message example

The example below illustrates an older message shape. For current message and
thread records, see [the shared chat schema](../../chat/README.md).

```
sender_id : String which is the original message sender's account id
event     : "chat" or "draft".  It's not really an "event"; type would have been better.
date      : A date string
history   : Array of "History" objects (described below)
editing   : Object of <account id's> : <"FUTURE">
```

"FUTURE" Will likely contain their last edit in the future

--- History object ---

```
author_id : String which is this message version's author's account id
content   : The raw display content of the message
date      : Date **string** of when this edit was sent
```

Example object:

```
{"sender_id":"07b12853-07e5-487f-906a-d7ae04536540",
"event":"chat",
"history":[
        {"author_id":"07b12853-07e5-487f-906a-d7ae04536540","content":"First edited!","date":"2016-07-23T23:10:15.331Z"},
        {"author_id":"07b12853-07e5-487f-906a-d7ae04536540","content":"Initial sent message!","date":"2016-07-23T23:10:04.837Z"}
        ],
"date":"2016-07-23T23:10:04.837Z","editing":{"07b12853-07e5-487f-906a-d7ae04536540":"FUTURE"}}
```

---

Compatibility message fields (plain JS; not the complete current schema):

```
sender_id : string
event     : "chat" | "draft"
date      : Date          // normalized from stored ISO
history   : MessageHistory[]  // newest first
editing   : string[] | object // legacy values may use an account-id map
schema_version : number   // version on the returned normalized copy
```
