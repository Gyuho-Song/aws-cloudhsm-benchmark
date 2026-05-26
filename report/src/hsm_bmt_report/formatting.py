"""Locale-stable formatting helpers.

Avoids depending on system locale (`ko_KR.UTF-8` may not be installed on Lambda /
container hosts). Uses `babel` which ships its own CLDR data.
"""

from __future__ import annotations

from babel.numbers import format_decimal


def korean_int(value: float | int) -> str:
    """Format an integer with Korean thousands separators."""
    return format_decimal(int(value), locale="ko_KR")


def korean_float(value: float, fraction_digits: int = 2) -> str:
    """Format a float with Korean separators and a fixed number of decimals."""
    pattern = "#,##0." + ("0" * fraction_digits) if fraction_digits > 0 else "#,##0"
    return format_decimal(value, format=pattern, locale="ko_KR")


def korean_percent(value: float, fraction_digits: int = 1) -> str:
    """Format a percentage with sign (+/-)."""
    sign = "+" if value >= 0 else ""
    return f"{sign}{korean_float(value, fraction_digits)}%"
