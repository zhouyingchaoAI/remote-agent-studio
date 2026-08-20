from __future__ import annotations

import re
import sys
from pathlib import Path

from docx import Document


def main(source: str, destination: str) -> None:
    lines = [p.text.strip() for p in Document(source).paragraphs if p.text.strip()]
    parts = []
    for index, line in enumerate(lines):
        if re.match(r"^\d+\.\s", line) and index + 1 < len(lines):
            answer = lines[index + 1]
            if answer.startswith("够用回答："):
                parts.extend([f"问题：{re.sub(r'^\d+\.\s*', '', line)}", answer.removeprefix("够用回答：")])
    Path(destination).write_text("\n\n".join(parts), encoding="utf-8")
    print(f"questions={len(parts) // 2}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
