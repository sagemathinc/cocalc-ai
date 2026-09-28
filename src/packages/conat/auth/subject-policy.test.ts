import {
  checkCommonPermissions,
  extractProjectSubject,
  extractViewerFileSubject,
  isFileServerManagementSubject,
  isProjectAllowed,
} from "./subject-policy";
import { inboxPrefix } from "@cocalc/conat/names";

describe("conat auth subject policy", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

  it("treats file-server subjects as project subjects", () => {
    expect(extractProjectSubject(`file-server.${PROJECT_ID}`)).toBe(PROJECT_ID);
    expect(extractProjectSubject(`file-server.${PROJECT_ID}.api`)).toBe(
      PROJECT_ID,
    );
  });

  it("denies project identities access to file-server management subjects", () => {
    expect(
      isProjectAllowed({
        project_id: PROJECT_ID,
        subject: `file-server.${PROJECT_ID}.api`,
      }),
    ).toBe(false);
    expect(isFileServerManagementSubject(`file-server.${PROJECT_ID}`)).toBe(
      true,
    );
    expect(isFileServerManagementSubject(`fs.project-${PROJECT_ID}`)).toBe(
      false,
    );
  });

  it("denies project identities access to account-bound and legacy ACP subjects", () => {
    const account_id = "22222222-2222-4222-8222-222222222222";
    expect(
      isProjectAllowed({
        project_id: PROJECT_ID,
        subject: `acp.project-${PROJECT_ID}.account-${account_id}.api`,
      }),
    ).toBe(false);
    expect(
      isProjectAllowed({
        project_id: PROJECT_ID,
        subject: `acp.project-${PROJECT_ID}.api`,
      }),
    ).toBe(false);
  });

  it("extracts viewer file subjects", () => {
    expect(
      extractViewerFileSubject(
        `fs-viewer.project-${PROJECT_ID}.account-${PROJECT_ID}`,
      ),
    ).toEqual({ project_id: PROJECT_ID, account_id: PROJECT_ID });
    expect(extractViewerFileSubject(`fs.project-${PROJECT_ID}`)).toBe(
      undefined,
    );
  });

  it("denies subscribing to another identity's inbox before project fallback", () => {
    expect(
      checkCommonPermissions({
        user: { account_id: "22222222-2222-4222-8222-222222222222" },
        userType: "account",
        userId: "22222222-2222-4222-8222-222222222222",
        subject: inboxPrefix({ project_id: PROJECT_ID }),
        type: "sub",
      }),
    ).toBe(false);
  });

  it("confines an API key to its server-issued reply inbox", () => {
    const account_id = "22222222-2222-4222-8222-222222222222";
    const own = "_INBOX.api-key-11111111-1111-4111-8111-111111111111";
    const other = "_INBOX.api-key-33333333-3333-4333-8333-333333333333";
    const allowed = (subject: string, prefix?: string) =>
      checkCommonPermissions({
        user: {
          account_id,
          auth_method: "api_key",
          auth_api_key_reply_prefix: prefix,
        },
        userType: "account",
        userId: account_id,
        subject,
        type: "sub",
      });
    expect(allowed(`${own}.reply`, own)).toBe(true);
    expect(allowed(`${own}-other.reply`, own)).toBe(false);
    expect(allowed(`${other}.reply`, own)).toBe(false);
    expect(allowed(`${inboxPrefix({ account_id })}.reply`, own)).toBe(false);
    expect(allowed(`${inboxPrefix({ account_id })}.reply`)).toBe(false);
  });
});
