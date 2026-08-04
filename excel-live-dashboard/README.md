# WVM Permit Dashboard

A lightweight web dashboard that reads the WVM Permit Spreadsheet and displays it in the browser, auto-refreshing every 15 seconds. Edit the Excel file, save it, watch the dashboard update.

- **Backend:** FastAPI + pandas + openpyxl
- **Frontend:** Plain HTML + Tailwind (CDN) + Chart.js + vanilla JS
- No Node, no bundlers, no build step.

## Project structure

```
excel-live-dashboard/
├── backend/
│   ├── main.py            # FastAPI app + /api/data endpoint
│   ├── requirements.txt
│   └── data/              # Drop your Excel file here
├── frontend/
│   ├── index.html         # Dashboard UI
│   └── app.js             # Fetch loop + rendering
├── .gitignore
└── README.md
```

## Prerequisites

- Python 3.10 or newer
- Any modern browser

## Setup

### 1. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Point at your Excel file

The dashboard reads **one** file. Two ways to set the path:

**Option A — environment variable (recommended):**

```bash
# macOS / Linux
export EXCEL_PATH="/path/to/WVM_Permit_Spreadsheet.xlsx"
uvicorn main:app --reload --port 8000

# Windows (PowerShell)
$env:EXCEL_PATH = "C:\Users\You\Documents\WVM_Permit_Spreadsheet.xlsx"
uvicorn main:app --reload --port 8000
```

**Option B — use the default:** Drop your file into `backend/data/WVM_Permit_Spreadsheet.xlsx` (the bundled default).

### 3. Run the backend

```bash
cd backend
uvicorn main:app --reload --port 8000
```

The API is now at `http://localhost:8000/api/data`.

### 4. Run the frontend

In a **new terminal**:

```bash
cd frontend
python -m http.server 5500
```

Open **http://localhost:5500** in your browser.

## Dashboard Features

- **KPI Cards** — Total permits, regulatory agencies, expiring permits (90 days), overdue inspections, upcoming inspections (30 days)
- **Charts** — Permits by regulatory agency, testing frequency distribution, permits by responsible person, expiration timeline
- **Data Table** — All permit records with category headers highlighted; overdue dates shown in red
- **Auto-refresh** — Polls every 15 seconds with near-instant updates via mtime checking

## API

### `GET /api/data`

```json
{
  "success": true,
  "last_updated": "2026-07-31T10:30:00+00:00",
  "row_count": 127,
  "columns": ["Tab", "Permit Type", "Permitted Operation", ...],
  "data": [...]
}
```

### `GET /api/mtime`

Cheap poll endpoint — returns only the file's last-modified time.

## Configuration

| Setting | File | What it does |
| --- | --- | --- |
| `EXCEL_PATH` | `backend/main.py` | Path to the Excel file (env var overrides) |
| `SHEET_NAME` | `backend/main.py` | Sheet name or index (default: first sheet) |
| `API_BASE` | `frontend/app.js` | Backend URL |
| `REFRESH_MS` | `frontend/app.js` | Full refresh interval (default: 15s) |

## Troubleshooting

**"Unable to load data" / Offline status** — Backend isn't running. Check uvicorn is up on port 8000.

**Dashboard doesn't update** — Make sure you're editing the same file the backend is reading (check `EXCEL_PATH`).

**CORS errors** — Serve `index.html` over HTTP (not `file://`).

## License

MIT
