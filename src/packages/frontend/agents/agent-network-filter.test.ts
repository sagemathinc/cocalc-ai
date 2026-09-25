import {
  readAgentNetworkFilter,
  rememberAgentNetworkFilter,
} from "./agent-network-filter";

beforeEach(() => {
  window.localStorage.clear();
});

test("restores the last selected network when the URL has no filter", () => {
  rememberAgentNetworkFilter("stored-network");
  expect(readAgentNetworkFilter("")).toBe("stored-network");
});

test("ignores legacy URL network filters", () => {
  rememberAgentNetworkFilter("stored-network");
  expect(readAgentNetworkFilter("?network=url-network")).toBe("stored-network");
});

test("clearing a network filter removes persisted state", () => {
  rememberAgentNetworkFilter("stored-network");
  rememberAgentNetworkFilter();
  expect(readAgentNetworkFilter("")).toBeUndefined();
});
