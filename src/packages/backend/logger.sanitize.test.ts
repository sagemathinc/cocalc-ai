import { myFormat, sanitizeForLog } from "./logger";

// A Stripe signature verification failure carries the webhook's
// Stripe-Signature header and raw body; neither may reach a log line.
class StripeSignatureVerificationError extends Error {
  type = "StripeSignatureVerificationError";
  header: string;
  payload: Buffer;
  raw: { message: string; headers: Record<string, string> };
  constructor(header: string, payload: Buffer) {
    super("No signatures found matching the expected signature for payload.");
    this.name = "StripeSignatureVerificationError";
    this.header = header;
    this.payload = payload;
    this.raw = {
      message: "raw",
      headers: { authorization: "Bearer SENTINEL-RAW" },
    };
  }
}

test("errors are logged through an allowlist, even nested", () => {
  const err = new StripeSignatureVerificationError(
    "t=1,v1=SENTINEL-SIGNATURE",
    Buffer.from('{"customer_email":"SENTINEL-BODY@example.com"}'),
  );
  const line = myFormat("Stripe webhook signature verification failed", {
    err,
  });
  expect(line).toContain("StripeSignatureVerificationError");
  expect(line).toContain("No signatures found");
  for (const sentinel of [
    "SENTINEL-SIGNATURE",
    "SENTINEL-BODY",
    "SENTINEL-RAW",
  ]) {
    expect(line).not.toContain(sentinel);
    expect(myFormat(err)).not.toContain(sentinel);
    expect(myFormat("x %o", err)).not.toContain(sentinel);
  }
  // The hex form of the body is not there either.
  expect(line).not.toContain(Buffer.from("SENTINEL-BODY").toString("hex"));
});

test("safe error fields, causes and ordinary values are kept", () => {
  const cause = Object.assign(new Error("inner"), {
    code: "ECONNRESET",
    secret: "S",
  });
  const err = Object.assign(new Error("outer", { cause }), {
    status: 503,
    requestId: "req_1",
    payload: "P",
  });
  expect(sanitizeForLog({ err, n: 1, list: ["a", { b: 2 }] })).toEqual({
    err: {
      name: "Error",
      message: "outer",
      status: 503,
      requestId: "req_1",
      stack: err.stack,
      cause: {
        name: "Error",
        message: "inner",
        code: "ECONNRESET",
        stack: cause.stack,
      },
    },
    n: 1,
    list: ["a", { b: 2 }],
  });
  const circular: any = { a: 1 };
  circular.self = circular;
  expect(() => myFormat("circular", circular)).not.toThrow();
});
