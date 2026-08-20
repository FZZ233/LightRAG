"""Tests for upload filename versioning."""

import importlib
import sys

import pytest


_original_argv = sys.argv[:]
sys.argv = [sys.argv[0]]
_document_routes = importlib.import_module("lightrag.api.routers.document_routes")
sys.argv = _original_argv

versioned_upload_filename = _document_routes.versioned_upload_filename

pytestmark = pytest.mark.offline


def test_versioned_upload_filename_increments_before_extension():
    assert versioned_upload_filename("report.pdf", 1) == "report.pdf"
    assert versioned_upload_filename("report.pdf", 2) == "report__v2.pdf"
    assert versioned_upload_filename("report.pdf", 3) == "report__v3.pdf"


def test_versioned_upload_filename_keeps_parser_hint_at_end():
    assert (
        versioned_upload_filename("report.[native].docx", 2)
        == "report__v2.[native].docx"
    )


def test_versioned_upload_filename_supports_names_without_extension():
    assert versioned_upload_filename("README", 2) == "README__v2"
