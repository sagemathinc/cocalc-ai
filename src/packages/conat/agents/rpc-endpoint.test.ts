import { safeKeyPreview, validateAgentEndpoint } from "./rpc";

const endpoint = {
  project_id: "00000000-0000-4000-8000-000000000001",
  agent_id: "00000000-0000-4000-8000-000000000002",
};

test("an unexpected endpoint field is named readably", () => {
  expect(() =>
    validateAgentEndpoint({ ...endpoint, kind: "x" } as any),
  ).toThrow(
    'unexpected endpoint field "kind"; an endpoint has only project_id and agent_id',
  );
});

test("the named field is escaped and bounded", () => {
  const rlo = String.fromCharCode(0x202e);
  const backslash = String.fromCharCode(92);
  const bidi = `ab${rlo}cd"${backslash}`;
  let message = "";
  try {
    validateAgentEndpoint({ ...endpoint, [bidi]: 1 } as any);
  } catch (error) {
    message = `${error}`;
  }
  expect(message).not.toContain(rlo);
  expect(message).toContain(
    `ab${backslash}u202ecd${backslash}u0022${backslash}u005c`,
  );
  const preview = safeKeyPreview("k".repeat(10000));
  expect(preview).toBe(`${"k".repeat(40)}...`);
  expect(
    [...safeKeyPreview(String.fromCharCode(0x200b, 7))].every(
      (c) => c.charCodeAt(0) < 0x7f && c.charCodeAt(0) >= 0x20,
    ),
  ).toBe(true);
});
