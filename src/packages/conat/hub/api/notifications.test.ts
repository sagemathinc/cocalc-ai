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
        project_id: "project-1",
      } as any),
    ).resolves.toBe(args);

    expect(args[0]).toEqual(
      expect.objectContaining({
        account_id: "target-account",
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
});
