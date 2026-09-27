/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ReactNode } from "react";
import { Alert, Button } from "antd";
import type { DirectoryPage } from "./use-directory";

export function DirectoryResults<T>({
  result,
  label,
  children,
  empty = "No matches. Try another search or clear a filter.",
  onRestart,
}: {
  result: DirectoryPage<T>;
  label: string;
  children: (items: T[]) => ReactNode;
  empty?: ReactNode;
  onRestart?: () => void;
}) {
  const { page, loading, error } = result;
  return (
    <section aria-label={label} aria-busy={loading}>
      {loading && !page && (
        <p role="status">Loading {label.toLowerCase()}...</p>
      )}
      {error && (
        <Alert
          role="alert"
          type="error"
          title={`Unable to load ${label.toLowerCase()}`}
          description={error}
          action={
            <>
              <Button onClick={result.refresh}>Retry</Button>
              {result.pageNumber > 1 && onRestart && (
                <Button onClick={onRestart}>Restart results</Button>
              )}
            </>
          }
        />
      )}
      {page && (
        <>
          {page.coverage !== "complete" && (
            <details style={{ marginBottom: 8 }}>
              <summary>
                {page.coverage === "indexing"
                  ? "Some results are still updating"
                  : "About these results"}
              </summary>
              <p>
                {page.coverage_message ||
                  "Some accessible work is not indexed yet. Missing results do not mean you have no access."}
              </p>
            </details>
          )}
          {page.items.length ? (
            children(page.items)
          ) : (
            <p role="status">{empty}</p>
          )}
          <nav aria-label={`${label} pages`} className="collaborators-actions">
            <Button disabled={result.pageNumber <= 1} onClick={result.previous}>
              Previous
            </Button>
            <span role="status">Page {result.pageNumber}</span>
            <Button disabled={!page.next} onClick={result.next}>
              Next
            </Button>
            <Button onClick={result.refresh}>Refresh</Button>
          </nav>
        </>
      )}
    </section>
  );
}
