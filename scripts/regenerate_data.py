#!/usr/bin/env python3
"""Rebuild the dashboard's incident data from the master Excel workbook.

Reads the ``Master_List_Of_Injuries`` sheet, normalises it, and writes:

  * ``data/incidents.json``  - the feed the "Live data" button fetches
  * ``index.html``           - the embedded fallback copy (used over file://)
                               and the prior-year comparison constants

Both copies are written together so the fetched feed and the offline
fallback can never drift apart.

Usage
-----
    python3 scripts/regenerate_data.py path/to/Master_List_Of_Injuries.xlsx

    --year 2026     focus year to publish (default: latest year in the sheet)
    --sheet NAME    source sheet name (default: Master_List_Of_Injuries)
    --json-only     write data/incidents.json, leave index.html untouched
    --check         report what would change, write nothing (exit 1 if stale)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import pandas as pd
except ImportError:
    sys.exit("pandas is required:  pip install pandas openpyxl")

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = REPO_ROOT / "data" / "incidents.json"
HTML_FILE = REPO_ROOT / "index.html"
DEFAULT_SHEET = "Master_List_Of_Injuries"

# Columns the dashboard depends on, as they appear in the sheet (pre-strip).
REQUIRED_COLUMNS = [
    "Employee Name", "DOI", "Supervisor", "Department",
    "Injury/Illness Type", "ESI Status", "Status", "Month", "Year",
]

MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Free-text injury types arrive with inconsistent spacing, casing and
# punctuation. These collapse the variants the sheet actually contains so
# one real category does not split across several chart slices.
STRUCK_OBJECT_VARIANTS = {
    "struck by-against object",
    "struck by - against object",
    "struck by against object",
    "struck by/against object",
}
TITLE_CASE_TYPES = {"struck by equipment", "struck by cattle"}


def normalise_injury_type(value) -> str:
    """Collapse spelling and spacing variants onto one canonical label."""
    if pd.isna(value):
        return "Unspecified"
    text = re.sub(r"\s+", " ", str(value).strip())
    text = text.replace("Stess", "Stress")  # recurring typo in the source
    key = text.lower()
    if key in STRUCK_OBJECT_VARIANTS:
        return "Struck By/Against Object"
    if key in TITLE_CASE_TYPES:
        return text.title()
    return text


def clean(value, fallback: str = "") -> str:
    if pd.isna(value):
        return fallback
    return re.sub(r"\s+", " ", str(value).strip())


def load_sheet(xlsx: Path, sheet: str) -> pd.DataFrame:
    frame = pd.read_excel(xlsx, sheet_name=sheet)
    frame.columns = [str(c).strip() for c in frame.columns]
    missing = [c for c in REQUIRED_COLUMNS if c not in frame.columns]
    if missing:
        sys.exit(
            f"Sheet '{sheet}' is missing required column(s): {', '.join(missing)}\n"
            f"Found: {', '.join(frame.columns)}"
        )
    frame["DOI"] = pd.to_datetime(frame["DOI"], errors="coerce")
    dropped = int(frame["DOI"].isna().sum())
    if dropped:
        print(f"  ! skipped {dropped} row(s) with an unreadable DOI date")
        frame = frame[frame["DOI"].notna()]
    return frame


def build_records(frame: pd.DataFrame) -> list[dict]:
    """Rows are emitted newest-first, matching the dashboard's ordering.

    Columns are addressed by name rather than position, so reordering or
    inserting columns in the workbook does not silently scramble the output.
    """
    frame = frame.sort_values("DOI", ascending=False)
    records = []
    for doi, name, dept, itype, esi, status, sup, month in zip(
        frame["DOI"], frame["Employee Name"], frame["Department"],
        frame["Injury/Illness Type"], frame["ESI Status"], frame["Status"],
        frame["Supervisor"], frame["Month"],
    ):
        records.append({
            "e": clean(name),
            "d": doi.strftime("%Y-%m-%d"),
            # %-d is not portable to Windows, so format the day by hand.
            "dd": f"{MONTH_ABBR[doi.month - 1]} {doi.day}, {doi.year}",
            "dept": clean(dept),
            "t": normalise_injury_type(itype),
            "esi": clean(esi).upper(),
            "s": clean(status, fallback="Open") or "Open",
            "sup": clean(sup),
            "m": clean(month),
        })
    return records


def prior_year_baseline(frame: pd.DataFrame, focus_year: int, latest_month: int) -> dict:
    """Prior-year totals through the end of the focus year's latest month.

    Month-granular so the comparison comes from whole months on both sides,
    which is how the workbook's own YTD comparison table was built.
    """
    prior = frame[(frame["Year"] == focus_year - 1) & (frame["DOI"].dt.month <= latest_month)]
    esi = prior["ESI Status"].map(lambda v: clean(v).upper())
    return {
        "total": int(len(prior)),
        "rec": int((esi == "RECORDABLE").sum()),
        "fa": int((esi == "FA").sum()),
        "rpo": int((esi == "RPO").sum()),
    }


def patch_html(html: str, payload: str, prior: dict) -> str:
    embedded = re.compile(
        r'(<script type="application/json" id="incidentData">).*?(</script>)', re.S)
    if not embedded.search(html):
        sys.exit("Could not find the embedded #incidentData block in index.html")
    html = embedded.sub(lambda m: m.group(1) + payload + m.group(2), html, count=1)

    constants = re.compile(r"const PRIOR_YTD = \{[^}]*\};")
    if not constants.search(html):
        sys.exit("Could not find the PRIOR_YTD constant in index.html")
    replacement = (f"const PRIOR_YTD = {{total:{prior['total']}, rec:{prior['rec']}, "
                   f"fa:{prior['fa']}, rpo:{prior['rpo']}}};")
    return constants.sub(replacement, html, count=1)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild the dashboard's incident data from the Excel workbook.")
    parser.add_argument("workbook", type=Path, help="path to the .xlsx master list")
    parser.add_argument("--year", type=int, help="focus year (default: latest in sheet)")
    parser.add_argument("--sheet", default=DEFAULT_SHEET, help=f"sheet name (default: {DEFAULT_SHEET})")
    parser.add_argument("--json-only", action="store_true", help="skip the index.html update")
    parser.add_argument("--check", action="store_true", help="report drift, write nothing")
    args = parser.parse_args()

    if not args.workbook.exists():
        sys.exit(f"Workbook not found: {args.workbook}")

    print(f"Reading {args.workbook.name} · sheet '{args.sheet}'")
    frame = load_sheet(args.workbook, args.sheet)

    focus_year = args.year if args.year else int(frame["Year"].max())
    current = frame[frame["Year"] == focus_year]
    if current.empty:
        available = ", ".join(str(y) for y in sorted(frame["Year"].dropna().unique()))
        sys.exit(f"No rows found for year {focus_year}. Available years: {available}")

    records = build_records(current)
    latest_month = int(current["DOI"].max().month)
    prior = prior_year_baseline(frame, focus_year, latest_month)
    payload = json.dumps(records, separators=(",", ":"), ensure_ascii=False)

    esi_counts: dict[str, int] = {}
    for record in records:
        esi_counts[record["esi"]] = esi_counts.get(record["esi"], 0) + 1

    print(f"\nFocus year {focus_year}: {len(records)} incidents")
    print(f"  latest incident : {records[0]['dd']}")
    for label in ("FA", "RPO", "RECORDABLE"):
        print(f"  {label:<15} : {esi_counts.get(label, 0)}")
    print(f"  departments     : {len({r['dept'] for r in records})}")
    print(f"  supervisors     : {len({r['sup'] for r in records})}")
    print(f"  {focus_year - 1} baseline  : total={prior['total']} rec={prior['rec']} "
          f"fa={prior['fa']} rpo={prior['rpo']}")

    old_payload = DATA_FILE.read_text(encoding="utf-8") if DATA_FILE.exists() else None
    data_changed = old_payload != payload

    if args.check:
        if data_changed:
            old_count = len(json.loads(old_payload)) if old_payload else 0
            print(f"\nSTALE: data/incidents.json would change ({old_count} -> {len(records)} rows)")
            return 1
        print("\nUp to date: data/incidents.json matches the workbook.")
        return 0

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(payload, encoding="utf-8")
    print(f"\nWrote {DATA_FILE.relative_to(REPO_ROOT)} "
          f"({'updated' if data_changed else 'unchanged'})")

    if not args.json_only:
        html = HTML_FILE.read_text(encoding="utf-8")
        patched = patch_html(html, payload, prior)
        HTML_FILE.write_text(patched, encoding="utf-8")
        print(f"Wrote {HTML_FILE.relative_to(REPO_ROOT)} "
              f"({'updated' if patched != html else 'unchanged'}) "
              "- embedded fallback + prior-year constants")

    print("\nDone. Reload the dashboard, or click \"Live data\" to pull the new feed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
