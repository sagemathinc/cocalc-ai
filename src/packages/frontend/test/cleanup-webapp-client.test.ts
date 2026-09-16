const { disconnectLoadedWebappClients } = require("./cleanup-webapp-client");

export {};

let disconnect: jest.SpyInstance;

it("cleans up loaded clients without initializing unused clients", () => {
  const wrapperPath = require.resolve("@cocalc/frontend/webapp-client");
  const clientPath = require.resolve("@cocalc/frontend/client/client");
  expect(require.cache[wrapperPath]).toBeUndefined();
  expect(require.cache[clientPath]).toBeUndefined();
  disconnectLoadedWebappClients();
  expect(require.cache[wrapperPath]).toBeUndefined();
  expect(require.cache[clientPath]).toBeUndefined();

  const { webapp_client } = require("@cocalc/frontend/client/client");
  disconnect = jest.spyOn(webapp_client.conat_client, "permanentlyDisconnect");
  disconnectLoadedWebappClients();
  expect(disconnect).toHaveBeenCalledTimes(1);

  expect(require("@cocalc/frontend/webapp-client").webapp_client).toBe(
    webapp_client,
  );
  disconnectLoadedWebappClients();
  expect(disconnect).toHaveBeenCalledTimes(2);
});

afterAll(() => {
  // The global setup hook runs first, and must disconnect the loaded client.
  expect(disconnect).toHaveBeenCalledTimes(3);
  disconnect.mockRestore();
});
