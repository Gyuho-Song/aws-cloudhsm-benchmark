"""PdfRenderer — WeasyPrint primary; documented fallback ladder for non-WeasyPrint hosts.

Per `application-design.md` §10:
  WeasyPrint → Asciidoctor-PDF → wkhtmltopdf → LaTeX (XeLaTeX + xeCJK)
"""

from __future__ import annotations

from pathlib import Path


class PdfRenderer:
    """Wraps WeasyPrint. Lazy-imports so the rest of the package is usable on hosts
    without GTK/Pango installed (e.g., a Lambda layer that only handles HTML)."""

    def __init__(self, base_url: Path | None = None) -> None:
        self.base_url = base_url

    def render(self, html: str, output_path: Path) -> None:
        try:
            from weasyprint import HTML  # type: ignore[import-untyped]
        except ImportError as e:  # pragma: no cover
            raise RuntimeError(
                "WeasyPrint not available on this host. Use the fallback engine "
                "(Asciidoctor-PDF or wkhtmltopdf) per application-design §10."
            ) from e
        HTML(string=html, base_url=str(self.base_url) if self.base_url else None).write_pdf(
            target=str(output_path)
        )
