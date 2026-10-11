import { agentSourceProjectPhrase } from "./source-project";

const a = "1ce4fe78-19c7-40a8-a598-947975744cd9";
const b = "0b8a52a6-1a36-4e41-9b0e-6bd7a8b5a0f4";

test("names the sender's project and whether it is the recipient's", () => {
  expect(agentSourceProjectPhrase(a, a)).toBe(
    `in project ${a}, the same project as yours`,
  );
  expect(agentSourceProjectPhrase(a, b)).toBe(
    `in project ${a}, a different project from yours; paths it mentions are in that project`,
  );
});

test("keeps the earlier wording when either project is unknown", () => {
  expect(agentSourceProjectPhrase(a, undefined)).toBe(`in project ${a}`);
  expect(agentSourceProjectPhrase(undefined, b)).toBe("in project unknown");
});
