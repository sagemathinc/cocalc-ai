# SOCKETS

## Confined return traffic

Socket discovery advertises `inboxReturn: 1` when the service supports private
return inboxes. New clients use that protocol; clients with a legacy peer retain
the service-subject protocol and must independently have its permissions.

In inbox-return mode, clients subscribe only beneath their authenticated reply
namespace. Every outgoing socket message carries `CN-SocketReturn`. The broker
validates that it is a concrete inbox subject the sender may subscribe to and
attests it in server-owned caller metadata. Services reject unattested routes
(including those passing through an older ingress broker) and bind each logical
socket to its original return route. No broader subscription grant is added.

Server-initiated requests use unpredictable correlation IDs. Their responses
return through the already-authorized service subject, not an arbitrary server
inbox. Each logical socket permits at most 128 outstanding reverse requests;
timeouts and socket close release them. Unknown and duplicate responses do not
resolve another request. Reverse requests accept one response.

Broker lease expiry removes the private subscription. Existing socket interest
cleanup then releases the logical socket; this does not terminate application
processes launched through it. New brokers and services must be deployed before
scoped clients rely on this protocol. Two-broker tests cover attestation forwarding,
bidirectional traffic, and expiry-driven interest withdrawal.

When the authenticated reply namespace changes, an inbox-return client socket
closes with `closeReason === "reply-namespace-changed"`. It does not redirect the
existing server socket or replay queued transport data on a different route.
Owners must create a fresh socket and explicitly reattach application state.
Terminal `attach` supports this without spawning a replacement process; real
PTY tests cover reattachment and rejection of operations on the old socket.
Automatic application recovery and deployed multibay rollout remain separate
validation requirements.

In compute networking, **TCP sockets** are a great idea that's been around since 1974! They are
incredibly useful as an abstraction. To create
a TCP socket you define source and target ports and ip address, and have a client
and server that are on a common network, so the client can connect to
the server. On the other hand, conat's pub/sub model lets you
instead have all clients/servers connect to a common "fabric"
and publish and subscribe using subject patterns and subjects.
This is extremley nice because there's no notion of ip addresses,
and clients and servers do not have to be directly connected to
each other.

The socket protocol sequences messages, acknowledges receipt, and retransmits
unacknowledged messages. This is an in-memory transport, not durable storage
or a guarantee that a completed application operation survives a process
restart. Writes can fail with `ENOBUFS` when the unacknowledged queue fills,
or `EPIPE` after the socket closes. Handle those failures and use application
acknowledgements when you need to establish that an operation completed.

This module provides an emulation of sockets but on top of the
conat pub/sub model. The server and clients agree on a common
_subject_ pattern of the form `${subject}.>` that they both
have read/write permissions for. Then the server listens for
new socket connections from clients. Sockets get setup and
the server can write to each one, they can write to the server,
and the server can broadcast to all connected sockets.
There are heartbeats to keep everything alive. When a client
or server properly closes a connection, the other side gets
immediately notified.

Of course you can also send arbitrary messages over the socket.

STATES:

- disconnected \- not actively sending or receiving messages. You can write to the socket and messages will be buffered to be sent when connected.
- connecting \- in the process of connecting
- ready \- actively connected and listening for incoming messages
- closed: _nothing_ further can be done with the socket.

A socket can be closed by the remote side.

LOAD BALANCING AND AUTOMATIC FAILOVER:

You can have several distinct socket servers for the same subject pattern,
and connection will get distributed between them, but once a connection
is created, it will persist in the expected way (i.e., the socket
connects with exactly one choice of server). If a client tries
to connect again with the same subject they may get a different server.
However, you can set the loadBalancer option on the client
to control this better (this is what the persist functionality does).

HEADERS ARE FULLY SUPPORTED:

If you just use s.write(data) and s.on('data', (data)=>) then
you get the raw data without headers. However, headers -- arbitrary
JSON separate from the raw (possibly binary) payload -- are supported.
You just have to pass a second argument:
`s.write(data, { headers })` and `s.on("data", (data, headers) => ...)`.

UNIT TESTS:

For unit tests, see

[backend socket integration tests](../../backend/conat/test/socket/basic.test.ts)
and the local [client](./client.test.ts), [base](./base.test.ts), and
[protocol](./tcp.test.ts) tests. Integration tests create their own local test
services; they are not a read-only production check.

WARNING:

If you create a socket server on with a given subject, then
it will use `${subject}.server.*` and `${subject}.client.*`, so
don't use `${subject}.>` for anything else!

DEVELOPMENT:

This local development sketch assumes a built workspace with package imports
available. It starts a local Conat service; select an unused port and a test
subject for which both clients have read/write permission. Start Node with:

```sh
CONAT_CLUSTER_PORT=3000 CONAT_SERVER=http://localhost:3000 node
```

Then enter the following in the Node REPL:

```js
// conat socketio server

s = await require("@cocalc/server/conat/socketio").initConatServer();
0;

// server side of socket

conat = await require("@cocalc/backend/conat").conat();
s = conat.socket.listen("conat.io");
s.on("connection", (socket) => {
  console.log("got new connection", socket.id);
  socket.on("data", (data) => console.log("got", { data }));
  socket.on("request", (mesg) => {
    console.log("responding...");
    mesg.respondSync("foo");
  });
});
0;

// client side of socket

conat = await require("@cocalc/backend/conat").conat();
c = conat.socket.connect("conat.io");
c.on("data", (data) => console.log("got", { data }));
0;

await s.waitUntilReady(5000);
await c.waitUntilReady(5000);
c.write("hi");
```
# Request Recovery and Replay

Socket `request` and `requestMany` may recover connection readiness before
publishing, but do not automatically republish after an execution attempt.
A response timeout, lost publish acknowledgment, or service-side `503` can occur
after an operation has already executed. Such errors are returned to the caller;
they are not evidence of rejection. Applications that retry must provide their
own idempotency or reconciliation contract. Ordered socket data retransmission
within the same logical connection is separate and remains unchanged.
