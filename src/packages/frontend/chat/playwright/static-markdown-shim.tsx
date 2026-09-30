// Plain text keeps realistic, content-dependent row heights for list tests.
export default function StaticMarkdown({ value }: { value?: string }) {
  return <div style={{ whiteSpace: "pre-wrap" }}>{value ?? ""}</div>;
}
