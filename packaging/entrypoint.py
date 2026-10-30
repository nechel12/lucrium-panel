"""Точка входа для PyInstaller (не пакет)."""

from __future__ import annotations

import sys

from lucrium_panel.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
