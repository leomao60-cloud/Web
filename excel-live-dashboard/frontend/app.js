/* -----------------------------------------------------------------------
 * Excel Live Dashboard — frontend logic.
 *
 * Polls the FastAPI backend every REFRESH_MS and re-renders the UI.
 * No frameworks — plain DOM updates.
 * ----------------------------------------------------------------------- */

// URL of the backend API. If you serve the frontend from a different origin
// (say, GitHub Pages) point this at your deployed backend instead.
const API_URL = "http://localhost:8000/api/data";

// How often to refresh, in milliseconds.
const REFRESH_MS = 15_000;

// Grab all the elements we'll be updating up front so we don't re-query them
// on every tick.
const el = {
  statusDot:      document.getElementById("status-dot"),
  statusText:     document.getElementById("status-text"),
  lastUpdated:    document.getElementById("last-updated"),
  sourceFile:     document.getElementById("source-file"),
  refreshBtn:     document.getElementById("refresh-btn"),
  errorBanner:    document.getElementById("error-banner"),
  errorMessage:   document.getElementById("error-message"),
  kpiRows:        document.getElementById("kpi-rows"),
  kpiCols:        document.getElementById("kpi-cols"),
  rowCountLabel:  document.getElementById("row-count-label"),
  tableHead:      document.getElementById("table-head"),
  tableBody:      document.getElementById("table-body"),
};

/* -----------------------------------------------------------------------
 * Status indicator
 * ----------------------------------------------------------------------- */

/**
 * Update the little status pill in the header.
 * @param {"live"|"error"|"loading"} state
 */
function setStatus(state) {
  const dotClasses = {
    live:    "bg-emerald-500",
    error:   "bg-red-500",
    loading: "bg-amber-500",
  };
  const labels = {
    live:    "Live",
    error:   "Offline",
    loading: "Refreshing…",
  };

  // Reset color classes, then apply the right one.
  el.statusDot.classList.remove("bg-emerald-500", "bg-red-500", "bg-amber-500", "bg-slate-400");
  el.statusDot.classList.add(dotClasses[state]);
  el.statusText.textContent = labels[state];
}

/* -----------------------------------------------------------------------
 * Error banner
 * ----------------------------------------------------------------------- */

function showError(message) {
  el.errorMessage.textContent = message;
  el.errorBanner.classList.remove("hidden");
}

function hideError() {
  el.errorBanner.classList.add("hidden");
}

/* -----------------------------------------------------------------------
 * Rendering
 * ----------------------------------------------------------------------- */

/** Turn any cell value into a safe display string. */
function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    // Trim long floats but keep integers as-is.
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }
  return String(value);
}

/** Format an ISO timestamp for the "last updated" line. */
function formatTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Render the table header row from a list of column names. */
function renderTableHead(columns) {
  el.tableHead.innerHTML = `
    <tr>
      ${columns.map(c => `
        <th class="px-6 py-3 text-left font-semibold">${escapeHtml(c)}</th>
      `).join("")}
    </tr>
  `;
}

/** Render table body rows. Handles the empty-file case. */
function renderTableBody(columns, rows) {
  if (!rows.length) {
    el.tableBody.innerHTML = `
      <tr>
        <td class="px-6 py-8 text-center text-slate-400" colspan="${Math.max(columns.length, 1)}">
          No data in the Excel file yet.
        </td>
      </tr>
    `;
    return;
  }

  el.tableBody.innerHTML = rows.map(row => `
    <tr class="hover:bg-slate-50">
      ${columns.map(c => `
        <td class="px-6 py-3 text-slate-700">${escapeHtml(formatCell(row[c]))}</td>
      `).join("")}
    </tr>
  `).join("");
}

/** Minimal HTML escaping so cell values can't inject markup. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* -----------------------------------------------------------------------
 * Main fetch + render cycle
 * ----------------------------------------------------------------------- */

async function refresh() {
  setStatus("loading");

  try {
    const res = await fetch(API_URL, { cache: "no-store" });

    // Parse JSON even on non-2xx so we can surface backend error codes.
    const payload = await res.json().catch(() => ({}));

    if (!res.ok || !payload.success) {
      const msg = payload?.error?.message
                || `Request failed with status ${res.status}`;
      throw new Error(msg);
    }

    // Happy path — update everything.
    hideError();
    setStatus("live");

    el.lastUpdated.textContent   = formatTimestamp(payload.last_updated);
    el.kpiRows.textContent       = payload.row_count.toLocaleString();
    el.kpiCols.textContent       = payload.columns.length.toLocaleString();
    el.rowCountLabel.textContent = `${payload.row_count.toLocaleString()} row${payload.row_count === 1 ? "" : "s"}`;

    if (payload.source_file) {
      el.sourceFile.textContent = payload.source_file;
      el.sourceFile.parentElement.setAttribute("title", payload.source_file);
    }

    renderTableHead(payload.columns);
    renderTableBody(payload.columns, payload.data);

    // TODO: build charts from payload.data using Chart.js.
    // The <canvas id="main-chart"> element is ready and waiting.

  } catch (err) {
    setStatus("error");
    showError(err.message || "Could not reach the backend.");
  }
}

/* -----------------------------------------------------------------------
 * Kick things off
 * ----------------------------------------------------------------------- */

refresh();                          // initial load
setInterval(refresh, REFRESH_MS);   // then every 15 seconds

// Manual refresh — useful for verifying an Excel edit without waiting.
el.refreshBtn.addEventListener("click", refresh);
