// Ignore the browser daemon's query marker, but never accept another route.
export function assertCapturedRoute(expected, actual) {
  if (!actual) throw Error("Screenshot did not report its page URL");
  const wanted = new URL(expected);
  const captured = new URL(actual);
  const path = (url) => url.pathname.replace(/\/$/, "") || "/";
  if (
    wanted.origin !== captured.origin ||
    path(wanted) !== path(captured) ||
    wanted.hash !== captured.hash
  ) {
    throw Error(
      `Expected ${wanted.pathname}${wanted.hash}, captured ${captured.pathname}${captured.hash}`,
    );
  }
  for (const [key, value] of wanted.searchParams) {
    if (captured.searchParams.get(key) !== value) {
      throw Error(`Captured route has different query parameter: ${key}`);
    }
  }
}
