/*
 *  This file is part of CoCalc: Copyright © 2024 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
LaTeX file summarization utilities for the LaTeX editor.
Provides functionality to generate summaries of LaTeX files using a Python script.
*/

// cSpell:ignore EOFPYTHON

import {
  exec,
  project_api,
} from "@cocalc/frontend/frame-editors/generic/client";
import { path_split } from "@cocalc/util/misc";

const SUMMARIZE_TEX_FILES = `
import sys
import json
import re
import os

def clean_latex_text(text):
    """Remove LaTeX commands and clean up text for readability"""
    # Remove comments
    text = re.sub(r'%.*$', '', text, flags=re.MULTILINE)

    # Remove common LaTeX commands but preserve content
    text = re.sub(r'\\\\(title|author|section|subsection|subsubsection|chapter)\\{([^}]*)\\}', r'**\\2**', text)
    text = re.sub(r'\\\\(emph|textit)\\{([^}]*)\\}', r'_\\2_', text)
    text = re.sub(r'\\\\(textbf|textsc)\\{([^}]*)\\}', r'**\\2**', text)

    # Remove other LaTeX commands
    text = re.sub(r'\\\\[a-zA-Z]+\\*?\\{[^}]*\\}', '', text)
    text = re.sub(r'\\\\[a-zA-Z]+\\*?', '', text)

    # Remove LaTeX environments but keep content
    text = re.sub(r'\\\\begin\\{[^}]*\\}', '', text)
    text = re.sub(r'\\\\end\\{[^}]*\\}', '', text)

    # Remove excessive whitespace
    text = re.sub(r'\\n\\s*\\n', '\\n', text)
    text = re.sub(r'\\s+', ' ', text).strip()

    return text

def extract_summary(filepath, home_dir):
    """Extract a meaningful summary from a LaTeX file"""
    if not filepath.endswith(('.tex', '.latex')):
        return "Non-LaTeX file"

    # Handle different path formats
    if filepath.startswith('~/'):
        # Path starts with ~/ - replace ~ with home directory
        expanded_path = os.path.join(home_dir, filepath[2:])
    elif os.path.isabs(filepath):
        # Absolute path - use as is
        expanded_path = filepath
    else:
        # Relative path - join with home directory
        expanded_path = os.path.join(home_dir, filepath)

    if not os.path.exists(expanded_path):
        return f"File not found: {expanded_path}"

    try:
        with open(expanded_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except Exception as e:
        return f"Error reading file: {str(e)}"

    # Extract first meaningful content (skip documentclass, packages, etc.)
    lines = content.split('\\n')
    useful_lines = []
    in_preamble = True
    has_document_env = '\\\\begin{document}' in content

    for line in lines:
        line = line.strip()
        if not line or line.startswith('%'):
            continue

        # Check if we're past the preamble
        if '\\\\begin{document}' in line:
            in_preamble = False
            continue

        # For files without \\begin{document}, treat everything as content
        if not has_document_env:
            in_preamble = False

        if in_preamble:
            # Extract title, author from preamble
            if line.startswith('\\\\title{') or line.startswith('\\\\author{'):
                useful_lines.append(line)
        else:
            # Extract meaningful content
            if any(cmd in line for cmd in ['\\\\section', '\\\\subsection', '\\\\chapter', '\\\\subsubsection']):
                useful_lines.append(line)
            elif line and not line.startswith('\\\\') and len(line) > 3:  # Lowered threshold
                useful_lines.append(line)
            elif line.startswith('\\\\') and len(line) > 10:  # Include some LaTeX commands
                useful_lines.append(line)

        # Limit to first 15 useful lines
        if len(useful_lines) >= 15:
            break

    # If we found some useful content, use it
    if useful_lines:
        summary_text = '\\n'.join(useful_lines[:8])  # Use more lines
        cleaned = clean_latex_text(summary_text)
        if cleaned and len(cleaned.strip()) > 0:
            # Convert to single line and truncate if too long
            cleaned = ' '.join(cleaned.split())  # Remove all newlines and extra spaces
            if len(cleaned) > 400:
                cleaned = cleaned[:397] + "..."
            return cleaned

    # Fallback: show raw content (first 400 chars, cleaned)
    # Remove comments first
    raw_content = re.sub(r'%.*$', '', content, flags=re.MULTILINE)
    raw_content = ' '.join(raw_content.split())  # Convert to single line

    if len(raw_content) > 400:
        raw_content = raw_content[:397] + "..."

    return raw_content if raw_content else "LaTeX document"

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: script.py <home_dir> <file1> <file2> ..."}))
        return

    home_dir = sys.argv[1]
    results = {}

    for filepath in sys.argv[2:]:
        results[filepath] = extract_summary(filepath, home_dir)

    print(json.dumps(results, ensure_ascii=False))

if __name__ == "__main__":
    main()
`;

export async function summarizeTexFiles(
  files: string[],
  project_id: string,
  path: string,
  homeDir: string,
): Promise<Record<string, string>> {
  const result = await exec({
    command: "python3",
    args: ["-c", SUMMARIZE_TEX_FILES, homeDir, ...files],
    project_id,
    path: path_split(path).head,
    timeout: 30,
  });
  if (result.exit_code !== 0) {
    throw Error(result.stderr || "File summary generation failed");
  }
  const summaries: unknown = JSON.parse(result.stdout);
  if (
    summaries == null ||
    typeof summaries !== "object" ||
    Array.isArray(summaries)
  ) {
    throw Error("Invalid file summary response");
  }
  return Object.fromEntries(
    files.map((file) => [
      file,
      typeof summaries[file] === "string" ? summaries[file] : "LaTeX document",
    ]),
  );
}

// Cache successful lookups across editor frames; retry failures.
const homeDirectories = new Map<string, Promise<string>>();
export function getSummaryHomeDirectory(project_id: string): Promise<string> {
  let home = homeDirectories.get(project_id);
  if (home == null) {
    home = project_api(project_id)
      .then((api) => api.getHomeDirectory())
      .catch((error) => {
        homeDirectories.delete(project_id);
        throw error;
      });
    homeDirectories.set(project_id, home);
  }
  return home;
}
