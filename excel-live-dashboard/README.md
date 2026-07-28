# Excel Live Dashboard

A lightweight web dashboard that reads an Excel file on the server and displays it in the browser, auto-refreshing every 15 seconds. Edit the file, save it, watch the dashboard update.

- **Backend:** FastAPI + pandas + openpyxl
- **Frontend:** Plain HTML + Tailwind (CDN) + Chart.js + vanilla JS
- No Node, no bundlers, no build step.

## Project structure

```
excel-live-dashboard/
├── backend/
│   ├── main.py            # FastAPI app + /api/data endpoint
│   ├── requirements.txt
│   └── data/              # Drop your Excel file here (dashboard.xlsx)
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

### 2. Add your Excel file

Drop your workbook into `backend/data/` and name it `dashboard.xlsx` — that's the default path. A sample workbook is already included so you can run the app immediately.

To use a different name or location, open `backend/main.py` and change the `EXCEL_PATH` constant near the top:

```python
EXCEL_PATH: Path = Path(__file__).parent / "data" / "dashboard.xlsx"
# or an absolute path:
# EXCEL_PATH: Path = Path("/Users/you/Documents/report.xlsx")
```

You can also change which sheet is read with `SHEET_NAME` (defaults to the first sheet).

### 3. Run the backend

From the `backend/` folder with your virtualenv active:

```bash
uvicorn main:app --reload --port 8000
```

The API is now available at `http://localhost:8000/api/data`.

### 4. Run the frontend

The frontend is just static files. The simplest way is Python's built-in server. In a **new terminal**:

```bash
cd frontend
python -m http.server 5500
```

Then open **http://localhost:5500** in your browser.

> Opening `index.html` directly via `file://` will work for viewing but browsers block `fetch()` from `file://` origins, so the data won't load. Always serve it over HTTP.

## Using it

- Edit your Excel file and save.
- Within 15 seconds the dashboard picks up the change automatically.
- The status pill in the header shows **Live** (green), **Refreshing…** (amber), or **Offline** (red).

## API

### `GET /api/data`

Success (`200`):

```json
{
  "success": true,
  "last_updated": "2026-01-15T10:30:00+00:00",
  "row_count": 42,
  "columns": ["Date", "Region", "Revenue"],
  "data": [
    { "Date": "2026-01-01T00:00:00", "Region": "West", "Revenue": 12500 }
  ]
}
```

Error (`404` / `500`):

```json
{
  "success": false,
  "error": { "code": "FILE_NOT_FOUND", "message": "Excel file not found at: ..." }
}
```

`last_updated` reflects the file's modification time on disk, so you can tell whether the source file has actually changed.

## Configuration reference

| Where | Setting | What it does |
| --- | --- | --- |
| `backend/main.py` | `EXCEL_PATH` | Path to the Excel file |
| `backend/main.py` | `SHEET_NAME` | Sheet name or index (default: first sheet) |
| `backend/main.py` | `CORS_ORIGINS` | Allowed frontend origins (`["*"]` for local dev) |
| `frontend/app.js` | `API_URL` | Backend endpoint the frontend hits |
| `frontend/app.js` | `REFRESH_MS` | Polling interval in milliseconds |

## Extending it

The frontend leaves obvious hooks for growth:

- **KPI cards** — `#kpi-rows` and `#kpi-cols` are already wired up. Two more cards are stubbed out and ready for your own calculations inside `refresh()` in `app.js`.
- **Charts** — a `<canvas id="main-chart">` is already in the DOM (currently hidden). Unhide it, hide `#chart-placeholder`, and build a Chart.js chart from `payload.data` in `refresh()`.
- **Filters / search** — the table is a straightforward `<table>`; add an `<input>` above it and filter `payload.data` before rendering.

## Troubleshooting

**"Unable to load data" / status shows Offline**
The backend isn't running or isn't reachable. Check that `uvicorn` is up on port 8000 and that `API_URL` in `app.js` matches.

**404 `FILE_NOT_FOUND`**
No file at `EXCEL_PATH`. Confirm the file exists and the path in `main.py` is correct.

**500 `READ_ERROR`**
Usually one of:
- The file is open in Excel with an exclusive lock — close it and try again.
- The file isn't a real `.xlsx` (e.g. it's `.xls` or a CSV renamed).
- The sheet named in `SHEET_NAME` doesn't exist.

**CORS errors in the browser console**
Make sure you're serving `index.html` over `http://` (not `file://`) and that `CORS_ORIGINS` in `main.py` includes your frontend's origin.

## License

MIT — do whatever you want with it.
