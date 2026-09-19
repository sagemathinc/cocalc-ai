import { createHmac } from "node:crypto";
import { conatPassword } from "@cocalc/backend/data";

const mockGetExamBrowserSession = jest.fn();
const mockGetExamRunStatusLocal = jest.fn();

jest.mock("./exam/controller", () => ({
  getExamBrowserBootstrap: jest.fn(),
  getExamBrowserSession: (...args: any[]) => mockGetExamBrowserSession(...args),
  getExamRunStatusLocal: (...args: any[]) => mockGetExamRunStatusLocal(...args),
  joinExamRun: jest.fn(),
}));

import {
  getExamJoinPage,
  getProjectHostCustomizePayload,
  isExamPostOriginAllowed,
  resolveExamSessionForRequest,
} from "./web";
import { resolveProjectHostBrowserSessionFromCookieHeader } from "./browser-session";

function createLegacySessionToken(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", conatPassword)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function createResponse() {
  const headers = new Map<string, string | string[]>();
  return {
    getHeader: jest.fn((name: string) => headers.get(name)),
    setHeader: jest.fn((name: string, value: string | string[]) => {
      headers.set(name, value);
    }),
    headers,
  } as any;
}

describe("project-host customize payload", () => {
  it("does not expose account scoped data", () => {
    const payload = getProjectHostCustomizePayload();
    expect(payload.configuration).toEqual({
      lite: false,
      project_host: true,
      site_name: "CoCalc Project Host",
    });
    expect((payload.configuration as any).account_id).toBeUndefined();
    expect(payload.registration).toBe(false);
    expect(payload.strategies).toEqual([]);
  });

  it("restricts the full frontend for an admitted exam session", () => {
    const exam_session = {
      delete_at: "2026-08-01T04:00:00.000Z",
      account: { account_id: "00000000-1000-4000-8000-000000000001" },
      project: { project_id: "00000000-1000-4000-8000-000000000002" },
    } as any;
    const payload = getProjectHostCustomizePayload({
      account_id: "00000000-1000-4000-8000-000000000001",
      project_id: "00000000-1000-4000-8000-000000000002",
      exam_mode: true,
      terminal_enabled: false,
      exam_session,
    });
    expect(payload.configuration).toMatchObject({
      exam_mode: true,
      terminal_enabled: false,
      stripe_enabled: false,
      zendesk: false,
      share_server: false,
      openai_enabled: false,
      agent_openai_codex_enabled: false,
      account_id: "00000000-1000-4000-8000-000000000001",
      project_id: "00000000-1000-4000-8000-000000000002",
      scratchpad_delete_at: "2026-08-01T04:00:00.000Z",
    });
    expect(payload.exam_session).toBe(exam_session);
  });
});

describe("project-host exam admission page", () => {
  beforeEach(() => {
    mockGetExamBrowserSession.mockReset();
    mockGetExamRunStatusLocal.mockReset();
    mockGetExamRunStatusLocal.mockReturnValue({
      admission_open: true,
      active_projects: 1,
      hostname: "exam.example.test",
    });
  });

  it("migrates a legacy cookie only for its active exam session", () => {
    jest.useFakeTimers();
    try {
      const now = new Date("2026-09-19T07:00:00.000Z");
      jest.setSystemTime(now);
      const now_s = Math.floor(now.getTime() / 1000);
      const account_id = "00000000-1000-4000-8000-000000000001";
      const legacyExp = now_s + 300;
      const legacy = createLegacySessionToken({
        account_id,
        iat: now_s - 60,
        exp: legacyExp,
        nonce: "55".repeat(12),
      });
      mockGetExamBrowserSession.mockReturnValue({
        account_id,
        project_id: "00000000-1000-4000-8000-000000000002",
        run_id: "00000000-1000-4000-8000-000000000003",
        expires_at_ms: (now_s + 600) * 1000,
        scheduled_stop_at_ms: (now_s + 500) * 1000,
      });
      const req = {
        headers: {
          cookie: `cocalc_project_host_session=${encodeURIComponent(legacy)}`,
          host: "exam.example.test",
        },
        socket: {},
      } as any;
      const res = createResponse();

      expect(resolveExamSessionForRequest(req, res)).toMatchObject({
        account_id,
      });
      const setCookie = `${res.headers.get("Set-Cookie")}`;
      const migrated = setCookie.match(
        /cocalc_project_host_session=([^;]+)/,
      )?.[1];
      expect(migrated).toBeDefined();
      expect(
        resolveProjectHostBrowserSessionFromCookieHeader(
          `cocalc_project_host_session=${migrated}`,
        ),
      ).toMatchObject({
        account_id,
        exp_s: legacyExp,
        restricted_exp_s: legacyExp,
      });
      expect(setCookie).toContain("Max-Age=300");
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not migrate a legacy cookie without an active exam session", () => {
    const now_s = Math.floor(Date.now() / 1000);
    const legacy = createLegacySessionToken({
      account_id: "00000000-1000-4000-8000-000000000001",
      iat: now_s,
      exp: now_s + 300,
      nonce: "66".repeat(12),
    });
    mockGetExamBrowserSession.mockReturnValue(undefined);
    const res = createResponse();

    expect(
      resolveExamSessionForRequest(
        {
          headers: {
            cookie: `cocalc_project_host_session=${encodeURIComponent(legacy)}`,
            host: "exam.example.test",
          },
          socket: {},
        } as any,
        res,
      ),
    ).toBeUndefined();
    expect(res.headers.get("Set-Cookie")).toBeUndefined();
  });

  it("accepts the public HTTPS origin behind an HTTP reverse proxy", () => {
    expect(
      isExamPostOriginAllowed({
        origin: "https://exam-host.example.test",
        host: "exam-host.example.test",
      }),
    ).toBe(true);
  });

  it("rejects cross-host and malformed admission origins", () => {
    expect(
      isExamPostOriginAllowed({
        origin: "https://attacker.example.test",
        host: "exam-host.example.test",
      }),
    ).toBe(false);
    expect(
      isExamPostOriginAllowed({
        origin: "not a URL",
        host: "exam-host.example.test",
      }),
    ).toBe(false);
  });

  it("only asks for the token while admission is open", () => {
    const open = getExamJoinPage({
      admission_open: true,
      title: "Linear Algebra Scratchpad",
      scheduled_stop_at: "2026-08-01T04:00:00.000Z",
    });
    expect(open).toContain('<meta name="referrer" content="same-origin">');
    expect(open).toContain('<script src="/exam/admission.js" defer></script>');
    expect(open).toContain("Temporary private computational project");
    expect(open).toContain("Linear Algebra Scratchpad");
    expect(open).toContain("Enter the token provided to you");
    expect(open).toContain("completely erased automatically");
    expect(open).toContain('datetime="2026-08-01T04:00:00.000Z"');
    expect(open).toContain("with nothing retained");
    expect(open).toContain("Access token");
    expect(open).toContain('name="token"');
    expect(open).not.toContain("admission is not open yet");
  });

  it("tells students to wait without asking for a token while closed", () => {
    const closed = getExamJoinPage({ admission_open: false });
    expect(closed).toContain("access is not open yet");
    expect(closed).toContain("Wait for access to open");
    expect(closed).not.toContain("Enter the token provided to you");
    expect(closed).not.toContain('name="token"');
  });

  it("explains instructor-controlled cleanup for practice sessions", () => {
    const page = getExamJoinPage({
      admission_open: true,
      cleanup_mode: "manual",
    });
    expect(page).toContain("until your instructor ends the session");
    expect(page).not.toContain("erased automatically");
  });
});
