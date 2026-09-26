import type { CreateElicitationResponse } from "@agentclientprotocol/sdk-v1";
import type { AcpAttentionQuestion } from "@cocalc/conat/ai/acp/types";

const fail = (): never => {
  throw Error("Unsupported ACP question form");
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    return fail();
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}

/** A deliberately explicit subset; unsupported constraints must never be ignored. */
export function harnessQuestionForm(input: unknown): {
  sessionId: string;
  questions: AcpAttentionQuestion[];
  response: (
    answers: Record<string, { answers: string[] }>,
  ) => CreateElicitationResponse;
} {
  const request = object(input);
  if (request.mode !== "form" || request.requestId != null) return fail();
  const sessionId = text(request.sessionId, 1024);
  const message = text(request.message, 4096);
  const schema = object(request.requestedSchema);
  keys(schema, [
    "type",
    "title",
    "description",
    "properties",
    "required",
    "_meta",
  ]);
  if (schema.type !== "object") return fail();
  const properties = object(schema.properties);
  const ids = Object.keys(properties);
  if (ids.length < 1 || ids.length > 3) return fail();
  if (
    !Array.isArray(schema.required) ||
    schema.required.length !== ids.length ||
    new Set(schema.required).size !== ids.length ||
    schema.required.some((id) => typeof id !== "string" || !ids.includes(id))
  )
    return fail();
  const fields = ids.map((id) => {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(id) ||
      ["constructor", "prototype", "__proto__"].includes(id)
    )
      return fail();
    const field = object(properties[id]);
    keys(field, [
      "type",
      "title",
      "description",
      "enum",
      "minLength",
      "maxLength",
      "_meta",
    ]);
    if (field.type !== "string") return fail();
    const minimum = field.minLength ?? 1;
    const maximum = field.maxLength ?? 2048;
    if (
      !Number.isInteger(minimum) ||
      !Number.isInteger(maximum) ||
      Number(minimum) < 1 ||
      Number(maximum) > 8192 ||
      Number(minimum) > Number(maximum)
    )
      return fail();
    let choices: string[] | undefined;
    if (field.enum != null) {
      if (
        !Array.isArray(field.enum) ||
        !field.enum.length ||
        field.enum.length > 10
      )
        return fail();
      choices = field.enum.map((choice) => text(choice, 128));
      if (
        new Set(choices).size !== choices.length ||
        choices.some(
          (choice) =>
            [...choice].length < Number(minimum) ||
            [...choice].length > Number(maximum),
        )
      )
        return fail();
    }
    const title = field.title == null ? id : text(field.title, 128);
    const description =
      field.description == null ? title : text(field.description, 2048);
    return {
      id,
      minimum: Number(minimum),
      maximum: Number(maximum),
      choices,
      question: {
        id,
        header: title,
        question: `${message}\n\n${description}\n\nDo not enter passwords, tokens or other secrets.`,
        isOther: !choices,
        options: choices?.map((label) => ({ label, description: label })),
      } satisfies AcpAttentionQuestion,
    };
  });
  return {
    sessionId,
    questions: fields.map(({ question }) => question),
    response(answers) {
      const received = object(answers);
      if (Object.keys(received).some((id) => !ids.includes(id))) return fail();
      const values = fields.map((field) => {
        const answer = object(received[field.id]).answers;
        if (!Array.isArray(answer) || answer.length > 1) return fail();
        if (!answer.length) return undefined;
        const value = answer[0];
        if (
          typeof value !== "string" ||
          [...value].length < field.minimum ||
          [...value].length > field.maximum ||
          (field.choices && !field.choices.includes(value))
        )
          return fail();
        return value;
      });
      if (values.every((value) => value === undefined))
        return { action: "decline" };
      if (values.some((value) => value === undefined)) return fail();
      return {
        action: "accept",
        content: Object.fromEntries(ids.map((id, i) => [id, values[i]!])),
      };
    },
  };
}
