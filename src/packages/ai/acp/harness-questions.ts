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

const SECRET_WARNING = "Do not enter passwords, tokens or other secrets.";

type HarnessQuestionForm = {
  sessionId: string;
  questions: AcpAttentionQuestion[];
  response: (
    answers: Record<string, { answers: string[] }>,
  ) => CreateElicitationResponse;
};

// Claude Code's AskUserQuestion, as its ACP adapter asks it: per question a
// field `question_N` (one choice: a string with `oneOf`; several: an array
// with `items.anyOf`) and an optional free-text companion
// `question_N_custom` (its "Other"), nothing required.
const ASK_FIELD = /^question_(\d+)(_custom)?$/;

function askOptions(
  value: unknown,
): { value: string; label: string; description?: string }[] {
  if (!Array.isArray(value) || !value.length || value.length > 10)
    return fail();
  const options = value.map((raw) => {
    const option = object(raw);
    keys(option, ["const", "title", "description", "_meta"]);
    const constant = text(option.const, 128);
    return {
      value: constant,
      label: option.title == null ? constant : text(option.title, 128),
      description:
        option.description == null ? undefined : text(option.description, 2048),
    };
  });
  if (new Set(options.map(({ value }) => value)).size !== options.length)
    return fail();
  return options;
}

function askUserQuestionForm(
  sessionId: string,
  message: string,
  schema: Record<string, unknown>,
): HarnessQuestionForm | undefined {
  const properties = object(schema.properties);
  const ids = Object.keys(properties);
  if (!ids.length || !ids.every((id) => ASK_FIELD.test(id))) return undefined;
  // Its signature, beyond the names: nothing required, and every question
  // offers its choices as oneOf (or items.anyOf). Any other form with such
  // names (enum choices, required fields) is a generic form, checked below.
  if (Array.isArray(schema.required) && schema.required.length)
    return undefined;
  const signature = ids
    .filter((id) => !id.endsWith("_custom"))
    .every((id) => {
      const field = properties[id] as Record<string, unknown> | null;
      if (!field || typeof field !== "object") return false;
      const items = field.items as Record<string, unknown> | null | undefined;
      return field.type === "array"
        ? items != null && typeof items === "object" && "anyOf" in items
        : "oneOf" in field;
    });
  if (!signature) return undefined;
  keys(schema, [
    "type",
    "title",
    "description",
    "properties",
    "required",
    "_meta",
  ]);
  if (schema.type !== "object") return fail();
  if (
    schema.required != null &&
    (!Array.isArray(schema.required) || schema.required.length)
  )
    return fail();
  const mains = ids.filter((id) => !id.endsWith("_custom"));
  if (mains.length < 1 || mains.length > 4) return fail();
  // Numbered from 0 without gaps.
  mains.forEach((_id, index) => {
    if (!mains.includes(`question_${index}`)) fail();
  });
  for (const id of ids)
    if (
      id.endsWith("_custom") &&
      !mains.includes(id.slice(0, -"_custom".length))
    )
      fail();
  const single = mains.length === 1;
  const fields = mains
    .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)))
    .map((id) => {
      const field = object(properties[id]);
      const multiple = field.type === "array";
      let options;
      if (multiple) {
        keys(field, ["type", "title", "description", "items", "_meta"]);
        const items = object(field.items);
        keys(items, ["anyOf"]);
        options = askOptions(items.anyOf);
      } else {
        if (field.type !== "string") return fail();
        keys(field, ["type", "title", "description", "oneOf", "_meta"]);
        options = askOptions(field.oneOf);
      }
      const customId = `${id}_custom`;
      const custom = properties[customId];
      if (custom != null) {
        const other = object(custom);
        keys(other, ["type", "title", "description", "_meta"]);
        if (other.type !== "string") return fail();
      }
      const header = field.title == null ? "" : text(field.title, 128);
      const asked =
        single || field.description == null
          ? message
          : text(field.description, 2048);
      return {
        id,
        customId: custom != null ? customId : undefined,
        multiple,
        options,
        question: {
          id,
          // The card shows the question itself: a header only if it adds one.
          header: header || "Question",
          question: `${asked}${multiple ? "\n\n(Choose one here; say more under Other.)" : ""}\n\n${SECRET_WARNING}`,
          isOther: custom != null,
          options: options.map(({ value, label, description }) => ({
            label: value,
            description: description ?? (label !== value ? label : undefined),
          })),
        } satisfies AcpAttentionQuestion,
      };
    });
  return {
    sessionId,
    questions: fields.map(({ question }) => question),
    response(answers) {
      const received = object(answers);
      if (Object.keys(received).some((id) => !mains.includes(id)))
        return fail();
      const content: Record<string, string | string[]> = {};
      for (const field of fields) {
        if (received[field.id] == null) continue;
        const answer = object(received[field.id]).answers;
        if (!Array.isArray(answer) || answer.length > 1) return fail();
        if (!answer.length) continue;
        const value = answer[0];
        if (typeof value !== "string" || !value.trim()) return fail();
        if (field.options.some((option) => option.value === value)) {
          content[field.id] = field.multiple ? [value] : value;
        } else if (field.customId && [...value].length <= 8192) {
          content[field.customId] = value;
        } else {
          return fail();
        }
      }
      if (!Object.keys(content).length) return { action: "decline" };
      return { action: "accept", content };
    },
  };
}

/** A deliberately explicit subset; unsupported constraints must never be ignored. */
export function harnessQuestionForm(input: unknown): HarnessQuestionForm {
  const request = object(input);
  if (request.mode !== "form" || request.requestId != null) return fail();
  keys(request, [
    "mode",
    "sessionId",
    "toolCallId",
    "message",
    "requestedSchema",
    "_meta",
  ]);
  const sessionId = text(request.sessionId, 1024);
  const message = text(request.message, 4096);
  const schema = object(request.requestedSchema);
  const asked = askUserQuestionForm(sessionId, message, schema);
  if (asked) return asked;
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
        question: `${message}\n\n${description}\n\n${SECRET_WARNING}`,
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
