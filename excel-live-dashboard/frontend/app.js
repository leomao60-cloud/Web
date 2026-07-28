/* -----------------------------------------------------------------------
 * Excel Live Dashboard — frontend logic.
 *
 * Polls the FastAPI backend every REFRESH_MS and re-renders the UI.
 * No frameworks — plain DOM updates.
 * ----------------------------------------------------------------------- */

// URLs for the backend. If you serve the frontend from a different origin
// (say, GitHub Pages) point these at your deployed backend instead.
const API_BASE  = "http://localhost:8000";
const API_URL   = `${API_BASE}/api/data`;
const MTIME_URL = `${API_BASE}/api/mtime`;

// Full-data poll interval — safety fallback if the mtime endpoint is down.
const REFRESH_MS = 15_000;
// Cheap mtime poll — reacts to Excel saves almost instantly (~2s).
const MTIME_POLL_MS = 2_000;

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
  deptCanvas:      document.getElementById("dept-chart"),
  deptEmpty:       document.getElementById("dept-empty"),
  supervisorList:  document.getElementById("supervisor-list"),
  statusCanvas:    document.getElementById("status-chart"),
  statusEmpty:     document.getElementById("status-empty"),
  filterBar:       document.getElementById("filter-bar"),
  filterSummary:   document.getElementById("filter-summary"),
  rowCountLabel:   document.getElementById("row-count-label"),
  tableHead:       document.getElementById("table-head"),
  tableBody:       document.getElementById("table-body"),
};

// Holds the Chart.js instances so we can destroy/recreate them on each refresh.
let chart = null;
let deptChart = null;
let statusChart = null;

// Last mtime we've fetched full data for. When /api/mtime changes, we refetch.
let lastKnownMtime = null;

// Cache of the most recent /api/data response so filter chip clicks can
// re-render everything without another network round-trip.
let latestPayload = null;

/* -----------------------------------------------------------------------
 * Date-range filter
 * ----------------------------------------------------------------------- */

// Each filter takes the anchor date (the most recent DOI in the data) and
// returns a predicate for whether a given Date belongs in that range.
const FILTERS = [
  { key: "all",       label: "All",           test: () => true },
  { key: "ytd",       label: "YTD",           test: (d, anchor) => d.getFullYear() === anchor.getFullYear() },
  { key: "last90",    label: "Last 90 days",  test: (d, anchor) => (anchor - d) / 86_400_000 <= 90 },
  { key: "last30",    label: "Last 30 days",  test: (d, anchor) => (anchor - d) / 86_400_000 <= 30 },
  { key: "month",     label: "Latest month",  test: (d, anchor) =>
      d.getFullYear() === anchor.getFullYear() && d.getMonth() === anchor.getMonth() },
];

let currentFilter = "all";

function getFilteredRows(payload) {
  const dateCol = findColumn(payload.columns, "DOI", "Date of Injury", "Date");
  if (!dateCol || currentFilter === "all") return payload.data;

  const filter = FILTERS.find(f => f.key === currentFilter);
  if (!filter) return payload.data;

  const dates = payload.data.map(r => parseDate(r[dateCol])).filter(Boolean);
  if (!dates.length) return payload.data;
  const anchor = new Date(Math.max(...dates.map(d => d.getTime())));

  return payload.data.filter(r => {
    const d = parseDate(r[dateCol]);
    return d && filter.test(d, anchor);
  });
}

function renderFilterBar() {
  el.filterBar.innerHTML = FILTERS.map(f => `
    <button data-filter="${f.key}"
            class="px-3 py-1 rounded-md text-xs font-medium border transition
                   ${f.key === currentFilter
                     ? "bg-slate-900 text-white border-slate-900"
                     : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"}">
      ${f.label}
    </button>
  `).join("");
  el.filterBar.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      currentFilter = btn.dataset.filter;
      renderFilterBar();  // repaint chip active state
      if (latestPayload) renderAll(latestPayload);
    });
  });
}

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
 * Department breakdown — horizontal bar of counts per department
 * ----------------------------------------------------------------------- */

function renderDeptChart(columns, rows) {
  const deptCol = findColumn(columns, "Department", "Department ", "Dept");
  if (!deptCol) {
    el.deptCanvas.classList.add("hidden");
    el.deptEmpty.classList.remove("hidden");
    return;
  }
  el.deptCanvas.classList.remove("hidden");
  el.deptEmpty.classList.add("hidden");

  // Tally, ignoring blanks. Trim to collapse "Harvest" vs "Harvest ".
  const tally = new Map();
  for (const r of rows) {
    const raw = r[deptCol];
    if (raw == null || String(raw).trim() === "") continue;
    const key = String(raw).trim();
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);

  if (deptChart) deptChart.destroy();
  deptChart = new Chart(el.deptCanvas, {
    type: "bar",
    data: {
      labels: sorted.map(([name]) => name),
      datasets: [{
        label: "Incidents",
        data: sorted.map(([, count]) => count),
        backgroundColor: "#14b8a6",  // teal-500
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        y: { grid: { display: false } },
      },
    },
  });
}

/* -----------------------------------------------------------------------
 * Top supervisors by open incidents
 * ----------------------------------------------------------------------- */

function renderSupervisorList(columns, rows) {
  const supCol    = findColumn(columns, "Supervisor");
  const statusCol = findColumn(columns, "Status");

  if (!supCol) {
    el.supervisorList.innerHTML =
      `<li class="text-slate-400 text-center py-8">No Supervisor column found.</li>`;
    return;
  }

  // If we have a Status column, filter to open rows only. Otherwise fall
  // back to counting all incidents per supervisor.
  const openRows = statusCol
    ? rows.filter(r => !isClosed(r[statusCol]))
    : rows;

  const tally = new Map();
  for (const r of openRows) {
    const raw = r[supCol];
    if (raw == null || String(raw).trim() === "") continue;
    const key = String(raw).trim();
    tally.set(key, (tally.get(key) || 0) + 1);
  }

  const top = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (!top.length) {
    el.supervisorList.innerHTML =
      `<li class="text-slate-400 text-center py-8">No open incidents.</li>`;
    return;
  }

  const max = top[0][1];
  el.supervisorList.innerHTML = top.map(([name, count], i) => {
    const widthPct = Math.max(4, Math.round((count / max) * 100));
    return `
      <li class="flex items-center gap-3">
        <span class="w-5 text-xs text-slate-400 tabular-nums">${i + 1}.</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between text-slate-700">
            <span class="truncate">${escapeHtml(name)}</span>
            <span class="font-semibold text-slate-900 ml-2">${count}</span>
          </div>
          <div class="h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
            <div class="h-full bg-amber-400" style="width:${widthPct}%"></div>
          </div>
        </div>
      </li>
    `;
  }).join("");
}

/* -----------------------------------------------------------------------
 * Status donut — open vs closed
 * ----------------------------------------------------------------------- */

function renderStatusChart(columns, rows) {
  const statusCol = findColumn(columns, "Status");
  if (!statusCol) {
    el.statusCanvas.classList.add("hidden");
    el.statusEmpty.classList.remove("hidden");
    return;
  }
  el.statusCanvas.classList.remove("hidden");
  el.statusEmpty.classList.add("hidden");

  let open = 0, closed = 0;
  for (const r of rows) {
    if (isClosed(r[statusCol])) closed += 1; else open += 1;
  }

  if (statusChart) statusChart.destroy();
  statusChart = new Chart(el.statusCanvas, {
    type: "doughnut",
    data: {
      labels: ["Open", "Closed"],
      datasets: [{
        data: [open, closed],
        backgroundColor: ["#f59e0b", "#10b981"],  // amber-500, emerald-500
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = open + closed;
              const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return `${ctx.label}: ${ctx.parsed} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

/* -----------------------------------------------------------------------
 * renderAll — applies the current filter, then repaints every panel
 * ----------------------------------------------------------------------- */

function renderAll(payload) {
  const filtered = getFilteredRows(payload);
  const total    = payload.data.length;
  const shown    = filtered.length;

  // KPIs and table use the filtered rows.
  el.kpiRows.textContent = shown.toLocaleString();
  el.kpiRowsSub.textContent = shown === total
    ? "across all records"
    : `${shown.toLocaleString()} of ${total.toLocaleString()} records`;
  el.rowCountLabel.textContent =
    `${shown.toLocaleString()} row${shown === 1 ? "" : "s"}`;

  // Filter summary in the toolbar.
  const filterLabel = FILTERS.find(f => f.key === currentFilter)?.label || "";
  el.filterSummary.textContent =
    shown === total
      ? `${total.toLocaleString()} records`
      : `${shown.toLocaleString()} of ${total.toLocaleString()} • ${filterLabel}`;

  renderKPIs(payload.columns, filtered);
  renderChart(payload.columns, filtered);
  renderStatusChart(payload.columns, filtered);
  renderDeptChart(payload.columns, filtered);
  renderSupervisorList(payload.columns, filtered);
  renderTableHead(payload.columns);
  renderTableBody(payload.columns, filtered);
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

    el.lastUpdated.textContent = formatTimestamp(payload.last_updated);
    el.kpiCols.textContent     = payload.columns.length.toLocaleString();

    if (payload.source_file) {
      el.sourceFile.textContent = payload.source_file;
      el.sourceFile.parentElement.setAttribute("title", payload.source_file);
    }

    // Cache the payload so filter chip clicks can re-render offline.
    latestPayload = payload;
    renderAll(payload);

    // Remember what version of the file we just rendered so the fast
    // mtime poll doesn't immediately refetch.
    lastKnownMtime = payload.last_updated;

  } catch (err) {
    setStatus("error");
    showError(err.message || "Could not reach the backend.");
  }
}

/* -----------------------------------------------------------------------
 * Kick things off
 * ----------------------------------------------------------------------- */

/* -----------------------------------------------------------------------
 * Near-instant updates via cheap mtime polling
 * -----------------------------------------------------------------------
 * We hit /api/mtime every couple of seconds — it just stats the file —
 * and only call the full /api/data endpoint when the mtime actually
 * changes. Result: an Excel save shows up in ~2s instead of up to 15s.
 * The 15s full refresh stays as a safety net in case the mtime endpoint
 * is unreachable.
 * ----------------------------------------------------------------------- */
async function checkForChanges() {
  try {
    const res = await fetch(MTIME_URL, { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json();
    if (!payload.success) return;
    if (payload.last_updated !== lastKnownMtime) {
      refresh();
    }
  } catch {
    // Silent — the 15s full-refresh tick will surface any real outage.
  }
}

renderFilterBar();                           // paint the chips once
refresh();                                   // initial load
setInterval(refresh, REFRESH_MS);            // safety-net full refresh
setInterval(checkForChanges, MTIME_POLL_MS); // fast mtime poll

// Manual refresh — useful for verifying an Excel edit without waiting.
el.refreshBtn.addEventListener("click", refresh);
