function escapeHtml(value: unknown): string {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function javascriptStringLiteral(value: unknown): string {
  return JSON.stringify(`${value ?? ""}`).replace(/</g, "\\u003c");
}

export default async function clientSideRedirect({ res, target }) {
  const href = escapeHtml(target);
  res.type("html").send(
    `<head>
  <script>
    window.onload = function () {
      window.location.href = ${javascriptStringLiteral(target)};
      setTimeout(function() {
        const element = document.getElementById('redirect-msg');
        element.style.display = 'block';
      }, 3000);
    };
  </script>
</head>
<body>
  <div id="redirect-msg" style="display: none;">
    You should be redirected to <a href="${href}">${href}</a>.
  </div>
</body>`,
  );
}
