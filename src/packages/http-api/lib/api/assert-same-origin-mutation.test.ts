import assertSameOriginMutation from "./assert-same-origin-mutation";

const request = ({
  origin = "https://cocalc.test",
  fetchSite = "same-origin",
}: {
  origin?: string | null;
  fetchSite?: string | null;
} = {}) => ({
  protocol: "https",
  secure: true,
  headers: { host: "cocalc.test" },
  get: (name: string) => (name.toLowerCase() === "host" ? "cocalc.test" : ""),
  header: (name: string) => {
    if (name.toLowerCase() === "origin") return origin;
    if (name.toLowerCase() === "sec-fetch-site") return fetchSite;
    return undefined;
  },
});

test("accepts an exact same-origin browser mutation", () => {
  expect(() => assertSameOriginMutation(request())).not.toThrow();
});

test.each([
  { origin: null },
  { origin: "https://foreign.test" },
  { fetchSite: "cross-site" },
  { fetchSite: "same-site" },
])("rejects missing or non-origin-bound mutation metadata: %p", (options) => {
  expect(() => assertSameOriginMutation(request(options))).toThrow(
    "same-origin browser request required",
  );
});
