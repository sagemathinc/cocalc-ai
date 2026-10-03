/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import MarkdownIt from "markdown-it";
import {
  makePeopleReference,
  parsePeopleReference,
  peopleReferencePlugin,
  serializePeopleReference,
} from "./people-references";

const project = "11111111-1111-4111-8111-111111111111";
const conversation = "22222222-2222-4222-8222-222222222222";
const entry = "a".repeat(64);

test("round trips canonical markup for each kind", () => {
  for (const [kind, id] of [
    ["conversation", conversation],
    ["artifact", entry],
    ["agent", conversation],
  ] as const) {
    const reference = makePeopleReference(kind, project, id, `Title <${kind}>`);
    const markup = serializePeopleReference(reference);
    expect(markup).toContain("&lt;");
    expect(parsePeopleReference(markup)).toEqual(reference);
  }
  expect(
    serializePeopleReference(
      makePeopleReference("conversation", project, conversation, "Plan"),
    ),
  ).toContain(`href="/people/conversations/${project}/${conversation}"`);
});

test("rejects tampered labels, destinations and invalid targets", () => {
  const markup = serializePeopleReference(
    makePeopleReference("conversation", project, conversation, "Plan"),
  );
  expect(
    parsePeopleReference(markup.replace(">Plan<", ">Other<")),
  ).toBeUndefined();
  expect(
    parsePeopleReference(markup.replace("/people/", "/evil/")),
  ).toBeUndefined();
  expect(() =>
    makePeopleReference("artifact", project, conversation, "x"),
  ).toThrow();
});

test("markdown keeps the reference intact even with punctuation in the label", () => {
  const md = new MarkdownIt({ html: true });
  md.use(peopleReferencePlugin);
  const reference = makePeopleReference(
    "artifact",
    project,
    entry,
    "a *starred* [label]",
  );
  const markup = serializePeopleReference(reference);
  const tokens = md.parseInline(`see ${markup} now`, {})[0].children!;
  expect(tokens.map((t) => t.type)).toEqual([
    "text",
    "people-reference",
    "text",
  ]);
  expect(md.renderInline(`see ${markup}`)).toBe(`see ${markup}`);
});
