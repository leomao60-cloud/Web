"""
Excel Live Dashboard — FastAPI backend.

Serves the contents of an Excel file as JSON via GET /api/data.
The frontend polls this endpoint every 15 seconds to stay in sync
with the file on disk.

Run locally:
    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Configuration — edit these to point at your file.
# ---------------------------------------------------------------------------

# Path to the Excel file, relative to this script. Change this to whatever
# workbook you want the dashboard to read from. It can also be an absolute
# path like Path("/Users/you/Documents/report.xlsx").
EXCEL_PATH: Path = Path(__file__).parent / "data" / "dashboard.xlsx"

# Which sheet to read. Use None for the first sheet, or a name like "Sales".
SHEET_NAME: str | int | None = 0

# Which origins are allowed to call this API. "*" is fine for local dev.
# For production, list your real frontend origin(s) instead.
CORS_ORIGINS: list[str] = ["*"]

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Excel Live Dashboard API", version="1.0.0")

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
    """
    Make a single cell value JSON-safe.

    pandas returns NaN, NaT, and numpy scalars which don't serialise cleanly.
    We convert those into None or native Python types.
    """
    # NaN / NaT — both counted as "missing" by pandas.
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if pd.isna(value):
        return None

    # Datetimes → ISO strings.
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()

    # Numpy scalars → native Python.
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass

    return value


def _read_excel() -> pd.DataFrame:
    """Read the configured Excel file into a DataFrame."""
    return pd.read_excel(EXCEL_PATH, sheet_name=SHEET_NAME, engine="openpyxl")


def _file_mtime_iso(path: Path) -> str:
    """Return the file's last-modified time as an ISO 8601 UTC string."""
    ts = path.stat().st_mtime
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _error(status: int, message: str, code: str) -> JSONResponse:
    """Uniform error envelope so the frontend can rely on the shape."""
    return JSONResponse(
        status_code=status,
        content={
            "success": False,
            "error": {"code": code, "message": message},
        },
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/")
def root() -> dict[str, str]:
    """Tiny health check so hitting the root gives something useful."""
    return {
        "service": "excel-live-dashboard",
        "status": "ok",
        "data_endpoint": "/api/data",
    }


@app.get("/api/data")
def get_data() -> JSONResponse:
    """
    Read the Excel file and return its contents as JSON.

    Response shape (success):
        {
            "success": true,
            "last_updated": "2026-01-15T10:30:00+00:00",
            "row_count": 42,
            "columns": ["col1", "col2", ...],
            "data": [ { "col1": ..., "col2": ... }, ... ]
        }
    """
    # Guard: file must exist.
    if not EXCEL_PATH.exists():
        return _error(
            status=404,
            message=f"Excel file not found at: {EXCEL_PATH}",
            code="FILE_NOT_FOUND",
        )

    # Read the workbook. Any parse error becomes a clean 500.
    try:
        df = _read_excel()
    except Exception as exc:  # openpyxl / pandas parse issues
        return _error(
            status=500,
            message=f"Failed to read Excel file: {exc}",
            code="READ_ERROR",
        )

    # Normalise column names to strings (Excel sometimes yields ints/dates).
    df.columns = [str(c) for c in df.columns]

    # Convert to a list of row dicts, cleaning values as we go.
    records: list[dict[str, Any]] = []
    for row in df.to_dict(orient="records"):
        records.append({k: _clean_value(v) for k, v in row.items()})

    return JSONResponse(
        content={
            "success": True,
            "last_updated": _file_mtime_iso(EXCEL_PATH),
            "row_count": len(records),
            "columns": list(df.columns),
            "data": records,
        }
    )
