# Updating the dashboard data

There are two ways to load a new workbook.

## 1. In the browser (no tooling needed)

Click the **gear icon** in the dashboard header, then drop in an `.xlsx`,
`.xlsm` or `.csv` file. The dashboard picks the most likely sheet, finds the
header row, and maps the columns automatically — you can correct any mapping
from the dropdowns, and it previews exactly what will be loaded before you
apply. Your choice is remembered on that browser, and **Reset to bundled
data** returns to the shipped dataset.

The file is read entirely in the browser and never uploaded anywhere. Reading
`.xlsx` uses the browser's built-in decompression, which needs a current
Chrome, Edge, Firefox or Safari; on an older browser, save the sheet as
`.csv` and load that instead.

Required columns: employee name, date of injury, department, injury/illness
type and ESI status. Supervisor and case status are optional (a blank case
status is treated as `Open`). Month and year are derived from the date, so
those columns aren't needed.

## 2. From the command line

Use this to regenerate the files committed to the repo, so the published
dashboard ships with new data for everyone rather than just one browser.

The dashboard reads its incidents from two places, both generated from the
master Excel workbook:

| File | Used for |
|---|---|
| `data/incidents.json` | the feed the **Live data** button fetches |
| `index.html` (embedded block) | offline fallback, so the page works over `file://` |

`regenerate_data.py` writes both together, so they cannot drift apart.

## Usage

```bash
python3 scripts/regenerate_data.py path/to/Master_List_Of_Injuries.xlsx
```

Then reload the dashboard, or click **Live data** to pull the new feed
without a reload.

### Options

| Flag | Effect |
|---|---|
| `--year 2026` | focus year to publish (default: latest year in the sheet) |
| `--sheet NAME` | source sheet (default: `Master_List_Of_Injuries`) |
| `--json-only` | write `data/incidents.json` only, leave `index.html` alone |
| `--check` | report drift and write nothing; exits `1` if stale (useful in CI) |

## What it does to the data

- Keeps rows for the focus year, newest first.
- Collapses injury-type variants that mean the same thing, so one category
  doesn't split across several chart slices — irregular spacing, the recurring
  `Stess` → `Stress` typo, and the several spellings of
  *Struck By/Against Object*.
- Treats a blank **Status** as `Open`.
- Skips rows whose `DOI` date can't be read, and says how many.
- Recomputes the prior-year comparison baseline (`PRIOR_YTD` in `index.html`)
  as that year's totals **through the end of the focus year's latest month**,
  so both sides of the comparison cover whole months. This reproduces the
  workbook's own YTD comparison table.

Everything else on the page — KPIs, charts, gauges, filters, supervisor
list — is derived in the browser from these rows, so no other file needs
touching when the data changes.

## Requirements

```bash
pip install pandas openpyxl
```
