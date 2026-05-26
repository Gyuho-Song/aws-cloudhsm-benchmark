"""Verifies babel-based Korean formatters work without a system locale."""

from __future__ import annotations

from hsm_bmt_report.formatting import korean_float, korean_int, korean_percent


def test_korean_int_uses_thousands_separator():
    assert korean_int(1234567) == "1,234,567"


def test_korean_float_default_two_decimals():
    assert korean_float(1234.5) == "1,234.50"


def test_korean_float_zero_decimals():
    assert korean_float(1234.5, fraction_digits=0) == "1,234"


def test_korean_percent_signed():
    assert korean_percent(12.345) == "+12.3%"
    assert korean_percent(-7.1).startswith("-")
