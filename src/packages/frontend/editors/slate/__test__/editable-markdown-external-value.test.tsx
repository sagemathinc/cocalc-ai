/** @jest-environment jsdom */

import { act, render, screen, waitFor } from "@testing-library/react";
import {
  EditableMarkdown,
  shouldPublishReadOnlyExternalSlateValue,
} from "../editable-markdown";

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

function StreamingMarkdown({ value }: { value: string }) {
  return (
    <EditableMarkdown
      value={value}
      read_only
      enableUpload={false}
      minimal
      hidePath
      disableWindowing
      noVfill
      showEditBar={false}
      height="auto"
      autoMinHeight={0}
    />
  );
}

describe("EditableMarkdown external read-only values", () => {
  it("never uses the forced publication path for collaborative editors", () => {
    expect(
      shouldPublishReadOnlyExternalSlateValue({
        readOnly: false,
        hasSyncstring: true,
      }),
    ).toBe(false);
    expect(
      shouldPublishReadOnlyExternalSlateValue({
        readOnly: true,
        hasSyncstring: true,
      }),
    ).toBe(false);
    expect(
      shouldPublishReadOnlyExternalSlateValue({
        readOnly: true,
        hasSyncstring: false,
      }),
    ).toBe(true);
  });

  it("renders the final value after rapid streaming updates", async () => {
    const { rerender } = render(
      <StreamingMarkdown value="Progress update: I'll run" />,
    );

    act(() => {
      rerender(
        <StreamingMarkdown value="Progress update: I'll run exactly three" />,
      );
      rerender(
        <StreamingMarkdown value="Progress update: I'll run exactly three independent, read-only commands." />,
      );
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          "Progress update: I'll run exactly three independent, read-only commands.",
        ),
      ).toBeTruthy();
    });
  });

  it("keeps rendering after a stream crosses the direct-set threshold", async () => {
    const { rerender } = render(<StreamingMarkdown value="Starting stream." />);
    const longActivity = Array.from(
      { length: 260 },
      (_, index) => `Activity block ${index + 1}.`,
    ).join("\n\n");

    rerender(<StreamingMarkdown value={longActivity} />);

    await waitFor(() => {
      expect(screen.getByText("Activity block 260.")).toBeTruthy();
    });

    rerender(
      <StreamingMarkdown
        value={`${longActivity}\n\nLatest activity after direct replacement.`}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Latest activity after direct replacement."),
      ).toBeTruthy();
    });
  });
});
