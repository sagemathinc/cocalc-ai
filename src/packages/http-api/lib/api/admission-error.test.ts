import { createMocks } from "./test-framework";
import { sendAdmissionError } from "./admission-error";

test.each([0, 1, 1000, 1001, Number.MAX_SAFE_INTEGER])(
  "returns a noncached 429 with a whole-second delay for %s ms",
  (retry_after_ms) => {
    const { res } = createMocks();
    expect(
      sendAdmissionError(
        res,
        Object.assign(new Error("private context"), {
          code: "api_search_rate_limited",
          retry_after_ms,
          credential: "private",
        }),
      ),
    ).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(res.getHeader("Cache-Control")).toBe("no-store");
    expect(res.getHeader("Retry-After")).toBe(
      String(Math.max(1, Math.ceil(retry_after_ms / 1000))),
    );
    expect(res._getJSONData()).toEqual({
      error: "API search rate limit exceeded",
      code: "api_search_rate_limited",
      retry_after_ms,
    });
  },
);

test.each([undefined, -1, 0.5, Infinity, NaN, "1000\r\nX-Injected: yes"])(
  "still rejects admission without fabricating a delay for %p",
  (retry_after_ms) => {
    const { res } = createMocks();
    expect(
      sendAdmissionError(res, {
        code: "api_search_rate_limited",
        retry_after_ms,
      }),
    ).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(res.getHeader("Retry-After")).toBeUndefined();
    expect(res._getJSONData()).not.toHaveProperty("retry_after_ms");
  },
);

test("does not reinterpret unknown errors or message text as admission denials", () => {
  const { res } = createMocks();
  expect(sendAdmissionError(res, new Error("api_search_rate_limited"))).toBe(
    false,
  );
  expect(res.statusCode).toBe(200);
  expect(res._isEndCalled()).toBe(false);
});
