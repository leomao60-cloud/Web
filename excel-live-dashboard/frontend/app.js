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
  statusDot:       document.getElementById("status-dot"),
  statusText:      document.getElementById("status-text"),
  lastUpdated:     document.getElementById("last-updated"),
  sourceFile:      document.getElementById("source-file"),
  refreshBtn:      document.getElementById("refresh-btn"),
  errorBanner:     document.getElementById("error-banner"),
  errorMessage:    document.getElementById("error-message"),
  kpiRows:         document.getElementById("kpi-rows"),
  kpiRowsSub:      document.getElementById("kpi-rows-sub"),
  kpiOpen:         document.getElementById("kpi-open"),
  kpiRecordable:   document.getElementById("kpi-recordable"),
  kpiThisMonth:    document.getElementById("kpi-this-month"),
  kpiThisMonthSub: document.getElementById("kpi-this-month-sub"),
  kpiCols:         document.getElementById("kpi-cols"),
  chartCanvas:     document.getElementById("main-chart"),
  chartSubtitle:   document.getElementById("chart-subtitle"),
  chartEmpty:      document.getElementById("chart-empty"),
  rowCountLabel:   document.getElementById("row-count-label"),
  tableHead:       document.getElementById("table-head"),
  tableBody:       document.getElementById("table-body"),
};

// Holds the Chart.js instance so we can destroy/recreate it on each refresh.
let chart = null;

// Case-insensitive column resolver — finds "DOI" whether the header is
// "DOI", "doi", " DOI ", etc. Returns the actual column name from the
// payload, or null if no match.
function findColumn(columns, ...candidates) {
  const norm = s => String(s).trim().toLowerCase();
  const wanted = candidates.map(norm);
  return columns.find(c => wanted.includes(norm(c))) || null;
}

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
 * KPIs — computed from the injury records
 * ----------------------------------------------------------------------- */

// A "closed" incident is one whose Status field reads Close/Closed. Anything
// else (blank, "Open", "In progress"…) counts as open — matches how the
// source workbook leaves the field blank for open records.
function isClosed(statusValue) {
  if (statusValue == null) return false;
  return /^clos/i.test(String(statusValue).trim());
}

function isRecordable(flagValue) {
  if (flagValue == null) return false;
  return /^y/i.test(String(flagValue).trim());
}

// Try to turn a cell into a Date. Handles ISO strings the backend already
// produced from pandas Timestamps. Returns null for anything unparseable.
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function renderKPIs(columns, rows) {
  const statusCol     = findColumn(columns, "Status");
  const recordableCol = findColumn(columns, "Recordable_Flag", "Recordable");
  const dateCol       = findColumn(columns, "DOI", "Date of Injury", "Date");

  // Open incidents
  if (statusCol) {
    const open = rows.filter(r => !isClosed(r[statusCol])).length;
    el.kpiOpen.textContent = open.toLocaleString();
  } else {
    el.kpiOpen.textContent = "—";
  }

  // Recordable incidents
  if (recordableCol) {
    const rec = rows.filter(r => isRecordable(r[recordableCol])).length;
    el.kpiRecordable.textContent = rec.toLocaleString();
  } else {
    el.kpiRecordable.textContent = "—";
  }

  // This month — anchored to the most recent DOI in the data, not "today",
  // so a historical workbook still shows a meaningful figure.
  if (dateCol) {
    const dates = rows.map(r => parseDate(r[dateCol])).filter(Boolean);
    if (dates.length) {
      const latest = new Date(Math.max(...dates.map(d => d.getTime())));
      const thisMonth = dates.filter(d =>
        d.getFullYear() === latest.getFullYear() && d.getMonth() === latest.getMonth()
      ).length;
      el.kpiThisMonth.textContent = thisMonth.toLocaleString();
      el.kpiThisMonthSub.textContent =
        latest.toLocaleString(undefined, { month: "long", year: "numeric" });
    } else {
      el.kpiThisMonth.textContent = "—";
      el.kpiThisMonthSub.textContent = "no dated rows";
    }
  } else {
    el.kpiThisMonth.textContent = "—";
    el.kpiThisMonthSub.textContent = "no DOI column";
  }
}

/* -----------------------------------------------------------------------
 * Chart — incidents per month for the latest year present
 * ----------------------------------------------------------------------- */

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function renderChart(columns, rows) {
  const dateCol = findColumn(columns, "DOI", "Date of Injury", "Date");

  // Nothing to chart without dates.
  if (!dateCol) {
    el.chartCanvas.classList.add("hidden");
    el.chartEmpty.classList.remove("hidden");
    el.chartSubtitle.textContent = "";
    return;
  }
  el.chartCanvas.classList.remove("hidden");
  el.chartEmpty.classList.add("hidden");

  // Bucket rows by (year, month), then focus on the most recent year.
  const dates = rows.map(r => parseDate(r[dateCol])).filter(Boolean);
  if (!dates.length) {
    el.chartSubtitle.textContent = "no dated rows";
    return;
  }

  const latestYear = Math.max(...dates.map(d => d.getFullYear()));
  const counts = new Array(12).fill(0);
  for (const d of dates) {
    if (d.getFullYear() === latestYear) counts[d.getMonth()] += 1;
  }
  el.chartSubtitle.textContent = String(latestYear);

  // Destroy the previous chart so successive polls don't stack canvases.
  if (chart) chart.destroy();
  chart = new Chart(el.chartCanvas, {
    type: "bar",
    data: {
      labels: MONTH_LABELS,
      datasets: [{
        label: "Incidents",
        data: counts,
        backgroundColor: "#0284c7",  // sky-600
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        x: { grid: { display: false } },
      },
    },
  });
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

    renderKPIs(payload.columns, payload.data);
    renderChart(payload.columns, payload.data);
    renderTableHead(payload.columns);
    renderTableBody(payload.columns, payload.data);

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
