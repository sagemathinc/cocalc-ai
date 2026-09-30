// Deliver already-generated HTML without requesting a nonexistent project file.
export function downloadHTML(html: string, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Give the browser time to consume the URL before releasing its storage.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
