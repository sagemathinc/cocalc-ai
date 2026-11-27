
def upsert_bashrc_block(path, start, end, comment, lines):
    import os

    existing_lines = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing_lines = f.read().splitlines()
    out = []
    in_block = False
    for line in existing_lines:
        if line == start:
            in_block = True
            continue
        if line == end:
            in_block = False
            continue
        if not in_block:
            out.append(line)
    while out and out[-1] == "":
        out.pop()
    if out:
        out.append("")
    out.extend([start, comment, *lines, end, ""])
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
