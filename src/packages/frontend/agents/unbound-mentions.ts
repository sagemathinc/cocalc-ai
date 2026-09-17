import { serializeAgentMention } from "@cocalc/util/agent-mentions";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";

function parts(value: string): string[] {
  // Preserve literal examples and authored links. Only unprotected prose is a
  // candidate; replacement still requires an explicit human selection.
  const protectedRanges: [number, number][] = [];
  const fences = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
  for (let match = fences.exec(value); match; match = fences.exec(value)) {
    const start = match.index;
    const close = new RegExp(
      `^ {0,3}${match[1][0]}{${match[1].length},}[ \\t]*(?:\\n|$)`,
      "gm",
    );
    close.lastIndex = fences.lastIndex;
    const end = close.exec(value);
    const until = end ? close.lastIndex : value.length;
    protectedRanges.push([start, until]);
    fences.lastIndex = until;
  }
  const protectedMarkup =
    /(`+)[\s\S]*?\1(?!`)|<span\b[^>]*>[\s\S]*?<\/span>|<!--[\s\S]*?(?:-->|$)|<[^>\n]+>|!?\[[^\]\n]*\](?:\((?:\\.|[^()\\]|\([^)]*\))*\)|\[[^\]\n]*\])|https?:\/\/[^\s]+/g;
  for (const match of value.matchAll(protectedMarkup))
    protectedRanges.push([match.index!, match.index! + match[0].length]);
  protectedRanges.sort((a, b) => a[0] - b[0]);
  const result: string[] = [];
  let cursor = 0;
  for (let i = 0; i < protectedRanges.length; i++) {
    const start = protectedRanges[i][0];
    let end = protectedRanges[i][1];
    while (i + 1 < protectedRanges.length && protectedRanges[i + 1][0] <= end)
      end = Math.max(end, protectedRanges[++i][1]);
    result.push(value.slice(cursor, start), value.slice(start, end));
    cursor = end;
  }
  result.push(value.slice(cursor));
  return result;
}
function pattern(name: string): RegExp {
  return new RegExp(`(^|[\\s(])@${name}(?![a-zA-Z0-9-])`, "g");
}
export function hasUnboundAgentName(value: string, name: string): boolean {
  return parts(value).some(
    (part, index) => index % 2 === 0 && pattern(name).test(part),
  );
}
export function bindAgentName(
  value: string,
  reference: AgentMentionReference,
): string {
  return parts(value)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            pattern(reference.name),
            (_match, prefix) => `${prefix}${serializeAgentMention(reference)}`,
          ),
    )
    .join("");
}
