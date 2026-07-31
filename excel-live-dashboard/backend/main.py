"""
WVM Permit Dashboard — FastAPI backend.

Serves the WVM Permit Spreadsheet as JSON via GET /api/data.
The frontend polls this endpoint every 15 seconds.

Run:
    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
EXCEL_PATH: Path = Path(
    os.environ.get("EXCEL_PATH")
    or Path(__file__).parent / "data" / "WVM_Permit_Spreadsheet.xlsx"
)

SHEET_NAME: str | int = 0

CORS_ORIGINS: list[str] = ["*"]

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = FastAPI(title="WVM Permit Dashboard API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _clean_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if pd.isna(value):
        return None
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    return value


def _normalize_col_name(name: str) -> str:
    """Collapse whitespace/newlines in column names to single spaces."""
    return " ".join(str(name).split())


def _read_excel() -> pd.DataFrame:
    df = pd.read_excel(EXCEL_PATH, sheet_name=SHEET_NAME, engine="openpyxl")
    df.columns = [_normalize_col_name(c) for c in df.columns]
    return df


def _file_mtime_iso(path: Path) -> str:
    ts = path.stat().st_mtime
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _error(status: int, message: str, code: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"success": False, "error": {"code": code, "message": message}},
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "wvm-permit-dashboard",
        "status": "ok",
        "data_endpoint": "/api/data",
    }


@app.get("/api/mtime")
def get_mtime() -> JSONResponse:
    if not EXCEL_PATH.exists():
        return _error(404, f"Excel file not found at: {EXCEL_PATH}", "FILE_NOT_FOUND")
    return JSONResponse(
        content={"success": True, "last_updated": _file_mtime_iso(EXCEL_PATH)},
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@app.get("/api/data")
def get_data() -> JSONResponse:
    if not EXCEL_PATH.exists():
        return _error(404, f"Excel file not found at: {EXCEL_PATH}", "FILE_NOT_FOUND")

    try:
        df = _read_excel()
    except Exception as exc:
        return _error(500, f"Failed to read Excel file: {exc}", "READ_ERROR")

    records: list[dict[str, Any]] = []
    for row in df.to_dict(orient="records"):
        records.append({k: _clean_value(v) for k, v in row.items()})

    return JSONResponse(
        content={
            "success": True,
            "last_updated": _file_mtime_iso(EXCEL_PATH),
            "source_file": str(EXCEL_PATH),
            "row_count": len(records),
            "columns": list(df.columns),
            "data": records,
        },
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )
