# Computers: lifecycle in the UI (Oct 12, 2026)

> **Superseded (2026-10-16)** by `computers-direct-host-2026-10-16.md`: computers now connect directly to their project's host, with at-most-once exec and no tickets, signed state or lease. Kept for history.

William's five points from trying `@m1` on lite1b, and the design that answers them. Companion to `computers-plan-2026-10-11.md`.

## The states a computer can be in

What the person sees, as one word, everywhere (the settings table, the `@` picker, the composer's Connectors menu, the mention modal):

| State | Meaning | How it gets there |
|---|---|---|
| **Connected** | Its connector is online now: a live session, seen in the last 45 s. | `cocalc computer connect` / `daemon` running. |
| **Offline** | Approved and within its time, but no live session. | The machine slept, lost network, or its process stopped. |
| **Ended** | Disconnected by you, or past its time limit. | Disconnect, or the "Until" time passed. |

A time-limited computer keeps its key only in its connector's memory. If its process stops, it can never come back on its own. So **Offline** for a time-limited computer means it needs to be paired again; for a computer without a time limit (key on disk), running `cocalc computer daemon` on the machine brings it back.

(Today the table's "Last seen" is only the last login time; the live heartbeat updates the session, not the computer. The server will compute `connected` and the real `last_seen` from the sessions.)

## Who can use it

A computer serves one agent network. An agent can use it when the agent is a member of that network. There are two separate questions, so there are two separate fixes:

1. **Is it connected?** If not: **Reconnect**.
2. **Can this agent use it?** If not: **add the agent to the computer's network**, with the reason shown, including what else that grants: membership also lets the agent message the network's other agents.

## Reconnect (issue 4)

A **Reconnect** button on every computer that isn't Connected:

- **Time-limited, or Ended:** Reconnect pairs it again, same name, same network, same time limit. It creates the pairing request (as the owner; no agent needed) and shows the one line to run on the machine. Then the usual approval follows: check the pairing phrase and approve, with fresh sign-in. If the old one is still within its time, Reconnect disconnects it first (it can't come back anyway), after saying so.
- **No time limit, Offline:** Reconnect shows the command to run on that machine (`cocalc computer daemon`), with "Pair it again instead" for a machine that lost its key.

## `@m1` in a message (issue 1)

- **Picker:** the `@` picker lists every computer you have that isn't removed, with its state (Connected / Offline / Ended) and whether this agent can use it. Choosing an Offline or Ended one is allowed.
- **Before sending:** like agent mentions, sending checks each mentioned computer. If anything is missing, a modal guides you, every time, even when the computer is connected:
  - **Not connected:** "@m1 is offline" with **Reconnect** (the flow above), or **Send anyway**.
  - **This agent can't use it:** "@claude-1 can't use @m1: @m1 serves the network *xyz*, and @claude-1 isn't in it." Then **Add @claude-1 to xyz**, which also lets it message xyz's agents (they're listed). Or **Send anyway**.
  - Both can apply; the modal shows both.
- **Send anyway:** sends; the agent's note says what it may not be able to do, and the agent tells you.

## The composer's Connectors menu (issue 5)

**Computers** goes in "Connectors for @claude-1", next to Agent Networks. Its status is the computers this agent can use now (`m1`, or `None`). It opens a dialog listing your computers, each with its state, whether this agent can use it, and the action: Reconnect, or Add to network.

## The Agent Networks settings panel (issues 2 and 3)

- **Kill switch at the top:** **Pause all messaging** and **Revoke all networks** move to the top of the panel. They also stop computers: a paused account gets no computer tickets, and revoking closes the networks computers serve. The text says so.
- **Computers table:** it shows the state word. "Last seen" and "Until" use TimeAgo, and there's a Reconnect button.

## Out of scope here

- Moving a computer to another network. Adding the agent to its network covers the need; moving can come later.
- Notifications when a computer goes offline.
