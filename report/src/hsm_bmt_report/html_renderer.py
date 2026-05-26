"""HtmlRenderer — uses Jinja2 to render `main.html.j2` with `ReportContext`.

Shared with PdfRenderer (PdfRenderer wraps HTML output through WeasyPrint).
"""

from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from .formatting import korean_float, korean_int, korean_percent
from .models import ReportContext

DEFAULT_TEMPLATE_DIR = Path(__file__).parent.parent.parent / "templates"


class HtmlRenderer:
    def __init__(self, template_dir: Path | None = None) -> None:
        td = template_dir or DEFAULT_TEMPLATE_DIR
        self.env = Environment(
            loader=FileSystemLoader(str(td)),
            autoescape=select_autoescape(["html", "j2"]),
            trim_blocks=True,
            lstrip_blocks=True,
        )
        # Korean number filters — locale-stable via babel (no system locale needed)
        self.env.filters["ko_int"] = korean_int
        self.env.filters["ko_float"] = korean_float
        self.env.filters["ko_pct"] = korean_percent

    def render(self, ctx: ReportContext) -> str:
        return self.env.get_template("main.html.j2").render(ctx=ctx)
