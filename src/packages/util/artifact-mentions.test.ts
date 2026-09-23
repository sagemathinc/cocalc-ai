import {
  extractArtifactMentions,
  parseArtifactMention,
  serializeArtifactMention,
} from "./artifact-mentions";

const reference = {
  version: 1 as const,
  project_id: "756629fd-ce98-4596-8595-1071d6c019a6",
  entry_id: "a".repeat(64),
  name: "nb1",
};

test("only a selected, bound artifact token is a mention", () => {
  const markup = serializeArtifactMention(reference);
  expect(parseArtifactMention(markup)).toEqual(reference);
  expect(extractArtifactMentions(`@nb1 ${markup} ${markup}`)).toEqual([
    reference,
  ]);
  expect(extractArtifactMentions("@nb1 [@nb1](/library/nb1)")).toEqual([]);
  expect(
    parseArtifactMention(markup.replace("@nb1", "@other")),
  ).toBeUndefined();
});
