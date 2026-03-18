const cellText =
  document.querySelector(".CodeMirror-scroll")?.textContent ??
  document.body.innerText;

return cellText.includes("X# bug-hunt fixture") && cellText.includes("2 + 3");
