# Updating the dashboard data

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
