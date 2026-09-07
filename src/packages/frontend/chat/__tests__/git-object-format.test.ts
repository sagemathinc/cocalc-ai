import { parseCommitHash } from "../git-commit/commit-selection";
import {
  parseGitShowOutput,
  parseGitLogOutput,
} from "../git-commit/git-output";
import {
  linkifyCommitHashes,
  extractFirstCommitMention,
} from "../git-commit-links";
import { readGitReviewRoute, setGitReviewRoute } from "../../git/review-route";

test.each([40, 64])(
  "preserves %i-character object IDs through links, navigation and Git output",
  (length) => {
    const hash = "a".repeat(length);
    expect(parseCommitHash(hash.toUpperCase())).toBe(hash);
    expect(extractFirstCommitMention(`commit ${hash}`)).toBe(hash);
    expect(linkifyCommitHashes(`commit ${hash}`)).toContain(hash);
    expect(
      parseGitShowOutput(`commit ${hash}\nAuthor: A\n`).summary.commit,
    ).toBe(hash);
    expect(parseGitLogOutput(`${hash}\t123\tsubject\n`)[0].hash).toBe(hash);
    const route = { commit: hash, cwd: "/work/tree" };
    expect(
      readGitReviewRoute(
        setGitReviewRoute(new URL("https://example.test/a"), route),
      ),
    ).toEqual(route);
  },
);

test("rejects overlong object IDs instead of truncating them", () => {
  const hash = "a".repeat(65);
  expect(parseCommitHash(hash)).toBeUndefined();
  expect(extractFirstCommitMention(`commit ${hash}`)).toBeUndefined();
  expect(parseGitShowOutput(`commit ${hash}\n`).summary.commit).toBeUndefined();
  expect(parseGitLogOutput(`${hash}\t123\tsubject\n`)).toEqual([]);
});
