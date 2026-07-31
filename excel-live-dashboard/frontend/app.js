/*
 * WVM Permit Dashboard — frontend logic.
 * Polls the FastAPI backend every 15s and re-renders the UI.
 */

const API_BASE  = "http://localhost:8000";
const API_URL   = `${API_BASE}/api/data`;
const MTIME_URL = `${API_BASE}/api/mtime`;

const REFRESH_MS   = 15_000;
const MTIME_POLL_MS = 2_000;

const el = {
  statusDot:    document.getElementById("status-dot"),
  statusText:   document.getElementById("status-text"),
  lastUpdated:  document.getElementById("last-updated"),
  sourceFile:   document.getElementById("source-file"),
  refreshBtn:   document.getElementById("refresh-btn"),
  errorBanner:  document.getElementById("error-banner"),
  errorMessage: document.getElementById("error-message"),
  kpiTotal:     document.getElementById("kpi-total"),
  kpiAgencies:  document.getElementById("kpi-agencies"),
  kpiExpiring:  document.getElementById("kpi-expiring"),
  kpiExpiringSub: document.getElementById("kpi-expiring-sub"),
  kpiOverdue:   document.getElementById("kpi-overdue"),
  kpiUpcoming:  document.getElementById("kpi-upcoming"),
  rowCountLabel: document.getElementById("row-count-label"),
  tableHead:    document.getElementById("table-head"),
  tableBody:    document.getElementById("table-body"),
  agencyWrap:   document.getElementById("agency-chart-wrap"),
  agencyCanvas: document.getElementById("agency-chart"),
  freqWrap:     document.getElementById("freq-chart-wrap"),
  freqCanvas:   document.getElementById("freq-chart"),
  personWrap:   document.getElementById("person-chart-wrap"),
  personCanvas: document.getElementById("person-chart"),
  expiryWrap:   document.getElementById("expiry-chart-wrap"),
  expiryCanvas: document.getElementById("expiry-chart"),
  expiryEmpty:  document.getElementById("expiry-empty"),
};

let agencyChart = null;
let freqChart   = null;
let personChart = null;
let expiryChart = null;

let lastKnownMtime  = null;
let refreshInFlight = false;

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------
// The Excel file has multi-line column headers. The backend normalizes them
// to single-space-separated strings.

const COL = {
  TAB:         "Tab",
  TYPE:        "Permit Type",
  OPERATION:   "Permitted Operation",
  NUMBER:      "Permit Number",
  EXPIRATION:  "Permit Expiration",
  DUE_DATE:    "Testing/ Insp. Due Date",
  COMPLETION:  "Testing/ Insp. Completion Date",
  EQUIPMENT:   "Equipment Description",
  CAPACITY:    "Capacity",
  UNITS:       "Units",
  PERSON:      "Facility Responsible Person",
  REQUIREMENTS: "Unit Requirements",
  LOCATION:    "Location/Info",
  OTHER:       "Other Info",
  TEST_REQ:    "Testing Required",
  FREQUENCY:   "Testing Frequency",
};

// Table shows a curated subset of columns
const TABLE_COLS = [
  COL.TAB, COL.TYPE, COL.OPERATION, COL.NUMBER,
  COL.EXPIRATION, COL.DUE_DATE, COL.EQUIPMENT,
  COL.PERSON, COL.FREQUENCY, COL.LOCATION,
];

// ---------------------------------------------------------------------------
// Data classification
// ---------------------------------------------------------------------------

function isPermitRow(row) {
  const tab = row[COL.TAB];
  if (tab == null) return false;
  return typeof tab === "number" && tab !== Math.floor(tab);
}

function isCategoryHeader(row) {
  const tab = row[COL.TAB];
  if (tab == null) return false;
  return typeof tab === "number" && tab === Math.floor(tab);
}

function getCategoryName(row) {
  return row[COL.TYPE] || "";
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

function setStatus(state) {
  const colors = { live: "bg-emerald-500", error: "bg-red-500", loading: "bg-amber-500" };
  const labels = { live: "Live", error: "Offline", loading: "Refreshing…" };
  el.statusDot.classList.remove("bg-emerald-500", "bg-red-500", "bg-amber-500", "bg-slate-400");
  el.statusDot.classList.add(colors[state]);
  el.statusText.textContent = labels[state];
}

function showError(msg) {
  el.errorMessage.textContent = msg;
  el.errorBanner.classList.remove("hidden");
}

function hideError() {
  el.errorBanner.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d)) return d.toLocaleDateString();
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }
  return String(value).trim();
}

function formatTimestamp(iso) {
  try { return new Date(iso).toLocaleString(); }
  catch { return iso; }
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

function renderKPIs(permits, categories) {
  const now = new Date();
  const in90 = new Date(now); in90.setDate(in90.getDate() + 90);
  const in30 = new Date(now); in30.setDate(in30.getDate() + 30);

  el.kpiTotal.textContent = permits.length.toLocaleString();
  el.kpiAgencies.textContent = categories.length.toLocaleString();

  // Expiring within 90 days
  let expiring = 0;
  for (const r of permits) {
    const d = parseDate(r[COL.EXPIRATION]);
    if (d && d >= now && d <= in90) expiring++;
  }
  el.kpiExpiring.textContent = expiring.toLocaleString();
  el.kpiExpiringSub.textContent = expiring > 0 ? "need attention soon" : "all clear";

  // Overdue inspections
  let overdue = 0;
  for (const r of permits) {
    const d = parseDate(r[COL.DUE_DATE]);
    if (d && d < now) overdue++;
  }
  el.kpiOverdue.textContent = overdue.toLocaleString();

  // Upcoming inspections in 30 days
  let upcoming = 0;
  for (const r of permits) {
    const d = parseDate(r[COL.DUE_DATE]);
    if (d && d >= now && d <= in30) upcoming++;
  }
  el.kpiUpcoming.textContent = upcoming.toLocaleString();
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

const CHART_COLORS = [
  "#0284c7", "#0891b2", "#0d9488", "#059669", "#16a34a",
  "#65a30d", "#ca8a04", "#d97706", "#ea580c", "#dc2626",
  "#e11d48", "#c026d3", "#9333ea", "#7c3aed",
];

function renderAgencyChart(permits, categories, allData) {
  // Build a map of Tab integer -> category name
  const catMap = {};
  for (const r of allData) {
    if (isCategoryHeader(r)) {
      catMap[Math.floor(r[COL.TAB])] = getCategoryName(r).trim();
    }
  }

  // Count permits per category
  const tally = {};
  for (const r of permits) {
    const catIdx = Math.floor(r[COL.TAB]);
    const name = catMap[catIdx] || `Category ${catIdx}`;
    tally[name] = (tally[name] || 0) + 1;
  }

  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);

  if (agencyChart) agencyChart.destroy();
  agencyChart = new Chart(el.agencyCanvas, {
    type: "bar",
    data: {
      labels: sorted.map(([n]) => n.length > 30 ? n.slice(0, 28) + "…" : n),
      datasets: [{
        label: "Permits",
        data: sorted.map(([, c]) => c),
        backgroundColor: CHART_COLORS.slice(0, sorted.length),
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

function renderFrequencyChart(permits) {
  const tally = {};
  for (const r of permits) {
    const freq = r[COL.FREQUENCY];
    if (!freq) continue;
    const key = String(freq).trim();
    tally[key] = (tally[key] || 0) + 1;
  }

  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);

  if (freqChart) freqChart.destroy();
  freqChart = new Chart(el.freqCanvas, {
    type: "doughnut",
    data: {
      labels: sorted.map(([n]) => n),
      datasets: [{
        data: sorted.map(([, c]) => c),
        backgroundColor: CHART_COLORS.slice(0, sorted.length),
        borderWidth: 2,
        borderColor: "#fff",
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "55%",
      plugins: {
        legend: {
          position: "right",
          labels: { boxWidth: 12, font: { size: 11 }, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = sorted.reduce((s, [, c]) => s + c, 0);
              const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return `${ctx.label}: ${ctx.parsed} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

function renderPersonChart(permits) {
  const tally = {};
  for (const r of permits) {
    const person = r[COL.PERSON];
    if (!person) continue;
    const key = String(person).trim().split("\n")[0].trim();
    tally[key] = (tally[key] || 0) + 1;
  }

  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8);

  if (personChart) personChart.destroy();
  personChart = new Chart(el.personCanvas, {
    type: "bar",
    data: {
      labels: sorted.map(([n]) => n),
      datasets: [{
        label: "Permits",
        data: sorted.map(([, c]) => c),
        backgroundColor: "#7c3aed",
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

function renderExpiryChart(permits) {
  const now = new Date();
  const buckets = {};

  for (const r of permits) {
    const d = parseDate(r[COL.EXPIRATION]);
    if (!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
    if (!buckets[key]) buckets[key] = { label, count: 0, isPast: d < now };
    buckets[key].count++;
  }

  const sorted = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));

  if (!sorted.length) {
    el.expiryWrap.classList.add("hidden");
    el.expiryEmpty.classList.remove("hidden");
    if (expiryChart) { expiryChart.destroy(); expiryChart = null; }
    return;
  }
  el.expiryWrap.classList.remove("hidden");
  el.expiryEmpty.classList.add("hidden");

  if (expiryChart) expiryChart.destroy();
  expiryChart = new Chart(el.expiryCanvas, {
    type: "bar",
    data: {
      labels: sorted.map(([, v]) => v.label),
      datasets: [{
        label: "Permits expiring",
        data: sorted.map(([, v]) => v.count),
        backgroundColor: sorted.map(([, v]) => v.isPast ? "#ef4444" : "#0284c7"),
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

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function renderTableHead(columns) {
  el.tableHead.innerHTML = `<tr>${columns.map(c =>
    `<th class="px-4 py-3 text-left font-semibold whitespace-nowrap">${escapeHtml(c)}</th>`
  ).join("")}</tr>`;
}

function renderTableBody(columns, rows) {
  if (!rows.length) {
    el.tableBody.innerHTML = `<tr><td class="px-6 py-8 text-center text-slate-400" colspan="${columns.length}">No data.</td></tr>`;
    return;
  }

  el.tableBody.innerHTML = rows.map(row => {
    const isHeader = isCategoryHeader(row);
    const rowClass = isHeader ? "bg-slate-100 font-semibold" : "hover:bg-slate-50";
    return `<tr class="${rowClass}">${columns.map(c => {
      const val = formatCell(row[c]);
      // Highlight overdue dates in red
      let extra = "";
      if ((c === COL.EXPIRATION || c === COL.DUE_DATE) && !isHeader) {
        const d = parseDate(row[c]);
        if (d && d < new Date()) extra = " text-red-600 font-medium";
      }
      return `<td class="px-4 py-2.5 text-slate-700 whitespace-nowrap${extra}">${escapeHtml(val)}</td>`;
    }).join("")}</tr>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Render all
// ---------------------------------------------------------------------------

function renderAll(payload) {
  const allData    = payload.data;
  const permits    = allData.filter(isPermitRow);
  const categories = allData.filter(isCategoryHeader);

  renderKPIs(permits, categories);
  renderAgencyChart(permits, categories, allData);
  renderFrequencyChart(permits);
  renderPersonChart(permits);
  renderExpiryChart(permits);

  // Use TABLE_COLS, filtered to only columns that exist in the payload
  const visibleCols = TABLE_COLS.filter(c => payload.columns.includes(c));
  renderTableHead(visibleCols);
  renderTableBody(visibleCols, allData);

  const permitCount = permits.length;
  el.rowCountLabel.textContent = `${permitCount} permit${permitCount === 1 ? "" : "s"} / ${allData.length} rows`;
}

// ---------------------------------------------------------------------------
// Fetch cycle
// ---------------------------------------------------------------------------

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  setStatus("loading");

  try {
    const res = await fetch(API_URL, { cache: "no-store" });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok || !payload.success) {
      throw new Error(payload?.error?.message || `Status ${res.status}`);
    }

    hideError();
    setStatus("live");

    el.lastUpdated.textContent = formatTimestamp(payload.last_updated);
    if (payload.source_file) {
      el.sourceFile.textContent = payload.source_file;
    }

    renderAll(payload);
    lastKnownMtime = payload.last_updated;

  } catch (err) {
    setStatus("error");
    showError(err.message || "Could not reach the backend.");
  } finally {
    refreshInFlight = false;
  }
}

async function checkForChanges() {
  try {
    const res = await fetch(MTIME_URL, { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json();
    if (payload.success && payload.last_updated !== lastKnownMtime) refresh();
  } catch { /* silent */ }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

refresh();
setInterval(refresh, REFRESH_MS);
setInterval(checkForChanges, MTIME_POLL_MS);
el.refreshBtn.addEventListener("click", refresh);
