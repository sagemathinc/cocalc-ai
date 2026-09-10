function disconnectLoadedWebappClients() {
  const clients = new Set();
  // Requiring the client here would initialize the entire application in pure
  // unit tests. Jest exposes already-loaded real modules through require.cache.
  for (const name of [
    "@cocalc/frontend/webapp-client",
    "@cocalc/frontend/client/client",
  ]) {
    const client = require.cache[require.resolve(name)]?.exports?.webapp_client;
    if (client != null) clients.add(client);
  }
  for (const client of clients) {
    client.conat_client?.permanentlyDisconnect?.();
  }
}

module.exports = { disconnectLoadedWebappClients };
