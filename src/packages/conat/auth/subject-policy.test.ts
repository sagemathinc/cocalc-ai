import { extractProjectSubject, isProjectAllowed } from "./subject-policy";

describe("conat auth subject policy", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

  it("treats file-server subjects as project subjects", () => {
    expect(extractProjectSubject(`file-server.${PROJECT_ID}`)).toBe(PROJECT_ID);
    expect(extractProjectSubject(`file-server.${PROJECT_ID}.api`)).toBe(
      PROJECT_ID,
    );
  });

  it("allows project identities to use their file-server subjects", () => {
    expect(
      isProjectAllowed({
        project_id: PROJECT_ID,
        subject: `file-server.${PROJECT_ID}.api`,
      }),
    ).toBe(true);
  });
});
