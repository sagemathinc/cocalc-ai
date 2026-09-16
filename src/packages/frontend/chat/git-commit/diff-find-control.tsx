import { Button, Input, Space, Typography } from "antd";
import type { Ref } from "react";
import type { InputRef } from "antd";

export function GitDiffFind({
  inputRef,
  query,
  onChange,
  onPrevious,
  onNext,
  count,
  index,
}: {
  inputRef: Ref<InputRef>;
  query: string;
  onChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  count: number;
  index: number;
}) {
  return (
    <div
      role="search"
      aria-label="Find in diff"
      style={{
        marginInlineStart: "auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      <Space.Compact size="small">
        <Input
          ref={inputRef}
          size="small"
          allowClear
          aria-label="Find in diff"
          placeholder="Find in diff"
          value={query}
          style={{ width: 160 }}
          onChange={(event) => onChange(event.target.value)}
          onPressEnter={(event) => (event.shiftKey ? onPrevious() : onNext())}
        />
        <Button
          size="small"
          aria-label="Previous diff match"
          disabled={!count}
          onClick={onPrevious}
        >
          Prev
        </Button>
        <Button
          size="small"
          aria-label="Next diff match"
          disabled={!count}
          onClick={onNext}
        >
          Next
        </Button>
      </Space.Compact>
      {query.trim() && (
        <Typography.Text
          type="secondary"
          role="status"
          style={{ fontSize: 12, whiteSpace: "nowrap" }}
        >
          {count ? `${index + 1} / ${count}` : "0 matches"}
        </Typography.Text>
      )}
    </div>
  );
}
