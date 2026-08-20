from __future__ import annotations

import re
import sys
from pathlib import Path

from docx import Document

source, target = map(Path, sys.argv[1:3])
target.mkdir(parents=True, exist_ok=True)
lines = [p.text.strip() for p in Document(source).paragraphs if p.text.strip()]
def spell_initialism(text: str) -> str:
    return re.sub(r"\b[A-Z]{2,}\b", lambda match: " ".join(match.group(0)), text)

count = 0
for index, line in enumerate(lines):
    if re.match(r"^\d+\.\s", line) and index + 1 < len(lines) and lines[index + 1].startswith("够用回答："):
        count += 1
        (target / f"{count:02d}-q.txt").write_text(spell_initialism(re.sub(r"^\d+\.\s*", "", line)), encoding="utf-8")
        (target / f"{count:02d}-a.txt").write_text(spell_initialism(lines[index + 1].removeprefix("够用回答：")), encoding="utf-8")
print(count)
