import {
  AUTH_RETRY_IN_ABOUT_PHRASE,
  formatRetryInAbout,
  parseRetryInAboutSeconds,
} from "./retry-window";

describe("conat auth retry window", () => {
  it("formats the shared retry phrase", () => {
    expect(AUTH_RETRY_IN_ABOUT_PHRASE).toBe("retry in about");
    expect(formatRetryInAbout(51)).toBe("retry in about 51s");
  });

  it("parses a retry window from backend auth errors", () => {
    expect(
      parseRetryInAboutSeconds(
        "too many authentication failures from 127.0.0.1; retry in about 51s",
      ),
    ).toBe(51);
  });
});
