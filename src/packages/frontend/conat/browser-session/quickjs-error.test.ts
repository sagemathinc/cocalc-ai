import { formatQuickJSErrorDump } from "./quickjs-error";

test("formatQuickJSErrorDump preserves QuickJS Error details", () => {
  const formatted = formatQuickJSErrorDump({
    name: "TypeError",
    message: "api.listOpenFiles is not a function",
    stack: "    at <anonymous> (eval.js:1:1)",
  });

  expect(formatted).toContain("TypeError: api.listOpenFiles is not a function");
  expect(formatted).toContain('"name":"TypeError"');
  expect(formatted).toContain(
    '"message":"api.listOpenFiles is not a function"',
  );
  expect(formatted).toContain('"stack":"');
});

test("formatQuickJSErrorDump handles non-Error QuickJS values", () => {
  const formatted = formatQuickJSErrorDump({ reason: "blocked" });

  expect(formatted).toContain("[object Object]");
  expect(formatted).toContain('"value":{"reason":"blocked"}');
});
