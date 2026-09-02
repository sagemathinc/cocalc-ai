describe("notifications auth routing", () => {
  it("forces account-authenticated codex turn notices to the signed-in account", async () => {
    const { notifications } = await import("./notifications");
    const args = [
      {
        account_id: "other-account",
        source_project_id: "project-1",
        source_path: "work/chat.chat",
        thread_id: "thread-1",
        title: "Codex turn finished",
        body_markdown: "done",
      },
    ];

    await expect(
      notifications.createCodexTurnNotice({
        args,
        account_id: "signed-in-account",
      } as any),
    ).resolves.toBe(args);

    expect(args[0]).toEqual(
      expect.objectContaining({
        account_id: "signed-in-account",
      }),
    );
  });

  it("allows project-authenticated codex turn notices with an explicit target account", async () => {
    const { notifications } = await import("./notifications");
    const args = [
      {
        account_id: "target-account",
        source_project_id: "spoofed-project",
        source_path: "work/chat.chat",
        thread_id: "thread-1",
        title: "Codex turn finished",
        body_markdown: "done",
      },
    ];

    await expect(
      notifications.createCodexTurnNotice({
        args,
        project_id: "project-1",
      } as any),
    ).resolves.toBe(args);

    expect(args[0]).toEqual(
      expect.objectContaining({
        account_id: "target-account",
        source_project_id: "project-1",
      }),
    );
  });

  it("rejects project-authenticated codex turn notices without a target account", async () => {
    const { notifications } = await import("./notifications");

    await expect(
      notifications.createCodexTurnNotice({
        args: [
          {
            source_project_id: "project-1",
            source_path: "work/chat.chat",
            thread_id: "thread-1",
            title: "Codex turn finished",
            body_markdown: "done",
          },
        ],
        project_id: "project-1",
      } as any),
    ).rejects.toThrow(
      "project-authenticated codex turn notices require an account_id target",
    );
  });

  it("allows host-authenticated codex turn notices with an explicit target account", async () => {
    const { notifications } = await import("./notifications");
    const args = [
      {
        account_id: "target-account",
        source_project_id: "project-1",
        source_path: "work/chat.chat",
        thread_id: "thread-1",
        title: "Codex turn finished",
        body_markdown: "done",
      },
    ];

    await expect(
      notifications.createCodexTurnNotice({
        args,
        host_id: "host-1",
      } as any),
    ).resolves.toBe(args);

    expect(args[0]).toEqual(
      expect.objectContaining({
        account_id: "target-account",
        host_id: "host-1",
      }),
    );
  });

  it("rejects host-authenticated codex turn notices without a target account", async () => {
    const { notifications } = await import("./notifications");

    await expect(
      notifications.createCodexTurnNotice({
        args: [
          {
            source_project_id: "project-1",
            source_path: "work/chat.chat",
            thread_id: "thread-1",
            title: "Codex turn finished",
            body_markdown: "done",
          },
        ],
        host_id: "host-1",
      } as any),
    ).rejects.toThrow(
      "host-authenticated codex turn notices require an account_id target",
    );
  });

  it.each([
    "createCodexAttentionNotice",
    "startCodexFreshAuthAction",
    "getCodexFreshAuthActionStatus",
  ])(
    "binds account-authenticated %s requests to that account",
    async (name) => {
      const { notifications } = await import("./notifications");
      const args = [{ account_id: "other-account" }];

      await expect(
        (notifications as any)[name]({
          args,
          account_id: "signed-in-account",
        } as any),
      ).resolves.toBe(args);
      expect(args[0].account_id).toBe("signed-in-account");
    },
  );

  it.each([
    "createCodexAttentionNotice",
    "startCodexFreshAuthAction",
    "getCodexFreshAuthActionStatus",
  ])("rejects project-authenticated %s requests", async (name) => {
    const { notifications } = await import("./notifications");

    await expect(
      (notifications as any)[name]({
        args: [{ account_id: "target-account" }],
        project_id: "project-1",
      } as any),
    ).rejects.toThrow();
  });

  it.each(["startCodexFreshAuthAction", "getCodexFreshAuthActionStatus"])(
    "binds managed agent %s requests to its exact account and project",
    async (name) => {
      const { notifications } = await import("./notifications");
      const args = [
        {
          account_id: "victim-account",
          source_project_id: "victim-project",
          host_id: "victim-host",
          agent_auth: { account_id: "victim-account" },
        },
      ];

      await expect(
        (notifications as any)[name]({
          args,
          account_id: "agent-account",
          project_id: "agent-project",
          auth_actor: "agent",
          auth_token_fingerprint: "fingerprint",
          auth_iat_s: 1,
          auth_exp_s: 2,
        } as any),
      ).resolves.toBe(args);
      expect(args[0]).toEqual({
        account_id: "agent-account",
        source_project_id: "agent-project",
      });
    },
  );

  it("allows a host to reconcile a bound Codex fresh-auth challenge", async () => {
    const { notifications } = await import("./notifications");
    const args = [
      {
        account_id: "target-account",
        source_project_id: "project-1",
        challenge_id: "challenge-1",
      },
    ];

    await expect(
      notifications.getCodexFreshAuthActionStatus({
        args,
        host_id: "host-1",
      } as any),
    ).resolves.toBe(args);
    expect(args[0]).toEqual({
      account_id: "target-account",
      source_project_id: "project-1",
      challenge_id: "challenge-1",
      host_id: "host-1",
    });
  });

  it("rejects a host fresh-auth status lookup without its bound target", async () => {
    const { notifications } = await import("./notifications");

    await expect(
      notifications.getCodexFreshAuthActionStatus({
        args: [{ challenge_id: "challenge-1" }],
        host_id: "host-1",
      } as any),
    ).rejects.toThrow(
      "host-authenticated Codex fresh-auth status requires an account and source project",
    );
  });
});
