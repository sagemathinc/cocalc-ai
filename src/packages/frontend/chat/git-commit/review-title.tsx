export function GitReviewTitle({ subject }: { subject?: string }) {
  const title = subject?.trim().split("\n")[0];
  return (
    <span className="git-review-title">
      <span>Git review</span>
      {title && (
        <strong className="git-review-title-subject" title={title}>
          {title}
        </strong>
      )}
    </span>
  );
}
