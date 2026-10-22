"""Repo checks for the skeleton: JSON parses, SVGs are well-formed XML, README links resolve."""

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

root = Path(__file__).resolve().parents[2]
errors: list[str] = []

json_files = sorted(p for p in root.rglob("*.json") if ".git" not in p.parts and "node_modules" not in p.parts)
for path in json_files:
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        errors.append(f"{path.relative_to(root)}: invalid JSON: {exc}")

svg_files = sorted((root / "assets").rglob("*.svg"))
for path in svg_files:
    try:
        ET.parse(path)
    except ET.ParseError as exc:
        errors.append(f"{path.relative_to(root)}: invalid SVG/XML: {exc}")

readme = (root / "README.md").read_text(encoding="utf-8")
refs = sorted(set(re.findall(r'(?:src|srcset|href)="([^"#:]+)"', readme)))
for ref in refs:
    if not (root / ref).is_file():
        errors.append(f"README.md: missing file {ref}")

for error in errors:
    print(f"::error::{error}")
print(f"checked {len(json_files)} JSON, {len(svg_files)} SVG, {len(refs)} README refs")
sys.exit(1 if errors else 0)
