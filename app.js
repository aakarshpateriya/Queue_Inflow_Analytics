/**
 * Salesforce Single-Queue Inflow Dashboard Controller
 */

const state = {
  queueName: "Admin Queue",
  timeRange: "thisMonth",
  customStart: null, // YYYY-MM-DD, used when timeRange === "custom"
  customEnd: null,   // YYYY-MM-DD, used when timeRange === "custom"
  selectedTab: "ALL",
  selectedStatusFilter: "ACTIVE", // Default view remains Active (New / Assigned)
  queueAgents: [],
  weeklyBifurcation: null,
  cases: [],
  filteredCases: [],
  charts: {},
  showMovingAverage: true,
  isLiveApiConnected: false,
  loadController: null,
  agentRange: "SAME", // timeframe of the agent workload table ("SAME" = follow the dashboard)
  agentCustomStart: null,
  agentCustomEnd: null,
  agentCases: null, // cases for the agent table when it has its own timeframe
  agentLoading: false,
  agentError: "",
  agentLoadController: null,
  instanceUrl: null, // Salesforce org URL, used to link case numbers
  kpiCases: { total: [], weekday: [], peak: [], aging: [] }, // cases behind each KPI card
  kpiMeta: {},
  drill: { title: "", cases: [], search: "", type: "ALL", sortKey: "routedDate", sortDir: "desc", lastFocus: null }
};

const SF_COLORS = {
  blue: "#0176D3",
  navy: "#032D60",
  orange: "#FE9339",
  green: "#2E844A",
  red: "#EA001E",
  purple: "#7F27CE",
  teal: "#0B827C",
  gridLines: "#EAEAEA"
};

// Vibrant, high-contrast palette for Case Statuses
const VIBRANT_STATUS_PALETTE = {
  New: "#00B4D8",           // Electric Sky Blue
  Assigned: "#FF7700",      // Vibrant Amber / Electric Orange
  "In Progress": "#8B5CF6", // Neon Violet / Purple
  Closed: "#10B981",        // Bright Mint / Emerald Green
  Resolved: "#06B6D4",      // Vivid Cyan
  Escalated: "#F43F5E",     // Hot Crimson / Rose Red
  Pending: "#FBBF24",       // Bright Golden Yellow
  "On Hold": "#EC4899",     // Neon Fuchsia / Pink
  Unknown: "#64748B"        // Slate Gray fallback
};

const FALLBACK_VIBRANT_COLORS = [
  "#00B4D8", "#FF7700", "#10B981", "#8B5CF6", 
  "#F43F5E", "#FBBF24", "#EC4899", "#06B6D4", 
  "#3B82F6", "#14B8A6", "#A855F7", "#FB923C"
];

document.addEventListener("DOMContentLoaded", async () => {
  // Snappier charts: the default 1-second animation runs on every redraw
  if (typeof Chart !== "undefined" && Chart.defaults && Chart.defaults.animation) {
    Chart.defaults.animation.duration = 200;
  }
  setupEventListeners();
  updateDateRangeLabel();
  await loadDashboardData();
});

// Human-readable description of a timeframe (used by the dashboard header and the agent table)
function describeWindow(range, customStart, customEnd) {
  const now = new Date();
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  if (range === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return `Window: ${fmt(start)} — ${fmt(now)} (Month-to-Date)`;
  } else if (range === "lastMonth") {
    const firstDayPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDayPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const monthName = firstDayPrevMonth.toLocaleDateString("en-US", { month: "short" });
    return `Window: ${monthName} 01 — ${monthName} ${lastDayPrevMonth.getDate()}, ${firstDayPrevMonth.getFullYear()}`;
  } else if (range === "bothMonths") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `Window: ${fmt(start)} — ${fmt(now)} (2-Month Window)`;
  } else if (range === "rolling30") {
    const past30 = new Date();
    past30.setDate(now.getDate() - 30);
    return `Window: ${fmt(past30)} — ${fmt(now)}`;
  } else if (range === "custom" && customStart && customEnd) {
    return `Window: ${fmt(parseLocalDate(customStart))} — ${fmt(parseLocalDate(customEnd))} (Custom)`;
  } else if (String(range).startsWith("pastWeek")) {
    const weekNum = parseInt(String(range).replace("pastWeek", ""), 10);
    const endDaysAgo = (weekNum - 1) * 7;
    const startDaysAgo = weekNum * 7;
    const end = new Date(); end.setDate(now.getDate() - endDaysAgo);
    const start = new Date(); start.setDate(now.getDate() - startDaysAgo);
    return `Window: ${fmt(start)} — ${fmt(end)} (Week ${weekNum})`;
  }
  return "";
}

function updateDateRangeLabel() {
  const labelElem = document.getElementById("dateRangeText");
  if (!labelElem) return;
  const text = describeWindow(state.timeRange, state.customStart, state.customEnd);
  if (text) labelElem.textContent = text;
}

function setLoading(isLoading) {
  document.body.classList.toggle("is-loading", isLoading);
  const refreshBtn = document.getElementById("refreshDataBtn");
  if (refreshBtn) refreshBtn.disabled = isLoading;
}

async function loadDashboardData() {
  updateDateRangeLabel();

  // Cancel any in-flight request so rapid timeframe changes don't queue up or overwrite newer data
  if (state.loadController) state.loadController.abort();
  const controller = new AbortController();
  state.loadController = controller;
  setLoading(true);

  try {
    let url = `/api/queue-inflow?queueName=${encodeURIComponent(state.queueName)}&range=${state.timeRange}`;
    if (state.timeRange === "custom") {
      url += `&start=${state.customStart}&end=${state.customEnd}`;
    }
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.records && Array.isArray(data.records)) {
      state.weeklyBifurcation = data.weeklyBifurcation || null;
      state.queueAgents = Array.isArray(data.queueAgents) ? data.queueAgents : [];
      state.instanceUrl = typeof data.instanceUrl === "string" && /^https:\/\//.test(data.instanceUrl) ? data.instanceUrl : null;
      mapIncomingRecords(data.records);
      populateStatusFilterOptions();
      state.isLiveApiConnected = true;
      if (state.agentRange !== "SAME") loadAgentCases();
      return;
    }
    throw new Error("Invalid response payload structure");
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer request
    console.warn("Could not retrieve live Salesforce data:", err.message);
    state.isLiveApiConnected = false;
  } finally {
    if (state.loadController === controller) {
      state.loadController = null;
      setLoading(false);
    }
  }
}

function normalizeType(rawType, subject = '') {
  const t = String(rawType || '').toLowerCase().trim();
  const s = String(subject || '').toLowerCase().trim();

  if (
    t.includes('feature') ||
    t.includes('enhancement') ||
    t.includes('change request') ||
    t.includes('improvement') ||
    t === 'cr' ||
    t === 'fr' ||
    t === 'rfc' ||
    s.startsWith('[fr]') ||
    s.startsWith('fr:') ||
    s.startsWith('[feature]') ||
    s.startsWith('feature:') ||
    s.includes('feature request')
  ) {
    return 'Feature Request';
  }

  if (t.includes('service') || t.includes('request') || t === 'sr') {
    return 'Service Request';
  }

  if (t.includes('query') || t.includes('question') || t.includes('inquiry')) {
    return 'Query';
  }

  if (t.includes('incident') || t.includes('issue') || t.includes('bug')) {
    return 'Incident';
  }

  return rawType || 'Incident';
}

const CORE_TYPES = ["Incident", "Service Request", "Query", "Feature Request"];

// Anything that is not one of the four standard types goes into "Other" (raw value is kept in rawType)
function canonicalType(rawType, subject) {
  const t = normalizeType(rawType, subject);
  return CORE_TYPES.includes(t) ? t : "Other";
}

// Turns one Salesforce record into the shape the dashboard uses
function mapRecord(r, i) {
  const rawDate = r.CreatedDate || new Date().toISOString();
  const dateObj = new Date(rawDate);
  const rawTypeValue = r.Type || r.Ticket_Type__c || r.RecordType?.Name;

  return {
    id: r.Id || `rec-${i}`,
    caseNumber: r.CaseNumber || `00${100000 + i}`,
    subject: r.Subject || "(No Subject)",
    agent: r.agent && r.agent !== "Unassigned" && r.agent !== "Admin Queue" ? r.agent : "Unassigned",
    rawType: String(rawTypeValue || "").trim(),
    type: canonicalType(rawTypeValue, r.Subject),
    priority: r.Automation_Priority__c || r.Priority || "Medium",
    origin: r.Origin || "Portal",
    routedDate: dateObj,
    dateKey: dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    weekLabel: r.weekLabel || "",
    hourOfDay: dateObj.getHours(),
    status: r.Status || "New"
  };
}

function mapIncomingRecords(raw) {
  state.cases = raw.map(mapRecord);

  updateTabBadges();
  applyFilters();
}

function updateTabBadges() {
  const counts = { ALL: state.cases.length, Incident: 0, "Service Request": 0, Query: 0, "Feature Request": 0, Other: 0 };
  state.cases.forEach((c) => {
    if (counts[c.type] !== undefined) counts[c.type]++;
  });

  const setBadge = (id, count) => {
    const elem = document.getElementById(id);
    if (elem) elem.textContent = count.toLocaleString();
  };

  setBadge("badgeAll", counts.ALL);
  setBadge("badgeIncident", counts.Incident);
  setBadge("badgeSR", counts["Service Request"]);
  setBadge("badgeQuery", counts.Query);
  setBadge("badgeFR", counts["Feature Request"]);
  setBadge("badgeOther", counts.Other);

  // The "Other" tab only appears when some cases don't fit the four standard types
  const otherTab = document.querySelector('.tab-nav-btn[data-tab="Other"]');
  if (otherTab) {
    otherTab.hidden = counts.Other === 0;
    if (counts.Other === 0 && state.selectedTab === "Other") {
      state.selectedTab = "ALL";
      document.querySelectorAll(".tab-nav-btn").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-tab") === "ALL");
      });
    }
  }
}

// Returns the [start, end] day window (local time) covered by the selected timeframe
function getTimeWindow() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);

  switch (state.timeRange) {
    case "thisMonth":
      return [new Date(now.getFullYear(), now.getMonth(), 1), today];
    case "lastMonth":
      return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0)];
    case "bothMonths":
      return [new Date(now.getFullYear(), now.getMonth() - 1, 1), today];
    case "rolling30":
      return [daysAgo(30), today];
    case "custom":
      return [parseLocalDate(state.customStart), parseLocalDate(state.customEnd)];
    default: {
      const weekNum = parseInt(state.timeRange.replace("pastWeek", ""), 10) || 1;
      return [daysAgo(weekNum * 7), daysAgo((weekNum - 1) * 7)];
    }
  }
}

function parseLocalDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function populateStatusFilterOptions() {
  const select = document.getElementById("statusFilter");
  if (!select) return;

  const currentVal = state.selectedStatusFilter || "ACTIVE";
  const uniqueStatuses = new Set();
  state.cases.forEach((c) => {
    if (c.status) uniqueStatuses.add(c.status);
  });

  select.innerHTML = `
    <option value="ACTIVE">Status: Active (New / Assigned)</option>
    <option value="ALL">Status: All (View All Cases)</option>
  `;

  if (uniqueStatuses.size > 0) {
    const optGroup = document.createElement("optgroup");
    optGroup.label = "Individual Statuses";
    Array.from(uniqueStatuses).sort().forEach((st) => {
      const opt = document.createElement("option");
      opt.value = st;
      opt.textContent = `Status: ${st}`;
      optGroup.appendChild(opt);
    });
    select.appendChild(optGroup);
  }

  select.value = currentVal;
}

function renderDashboard() {
  updateKPICards();
  renderDailyInflowChart();
  renderStatusChart();
  renderHourlyCurveChart();
  renderAgentWorkloadTable();
  renderAgentNote();
  renderTable();
}

function updateKPICards() {
  const total = state.filteredCases.length;
  const totalElem = document.getElementById("kpiTotalInflow");
  if (totalElem) totalElem.textContent = total.toLocaleString();

  const now = new Date();
  let startDate = new Date();
  let endDate = new Date();

  if (state.timeRange === "thisMonth") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (state.timeRange === "lastMonth") {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (state.timeRange === "bothMonths") {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (state.timeRange === "rolling30") {
    startDate.setDate(now.getDate() - 29);
  } else if (state.timeRange === "custom" && state.customStart && state.customEnd) {
    startDate = parseLocalDate(state.customStart);
    endDate = parseLocalDate(state.customEnd);
  } else if (state.timeRange.startsWith("pastWeek")) {
    const weekNum = parseInt(state.timeRange.replace("pastWeek", ""), 10);
    endDate.setDate(now.getDate() - (weekNum - 1) * 7);
    startDate.setDate(now.getDate() - weekNum * 7);
  }

  let businessDaysCount = 0;
  let cur = new Date(startDate);
  cur.setHours(0, 0, 0, 0);
  const endCheck = new Date(endDate);
  endCheck.setHours(23, 59, 59, 999);

  while (cur <= endCheck) {
    const dayOfWeek = cur.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) businessDaysCount++;
    cur.setDate(cur.getDate() + 1);
  }
  businessDaysCount = Math.max(1, businessDaysCount);

  const weekdayCases = state.filteredCases.filter((c) => {
    const d = c.routedDate.getDay();
    return d !== 0 && d !== 6;
  });

  const dailyAvg = (weekdayCases.length / businessDaysCount).toFixed(1);
  const avgElem = document.getElementById("kpiDailyAvg");
  if (avgElem) avgElem.textContent = dailyAvg;

  const avgSplitElem = document.getElementById("kpiAvgSplit");
  if (avgSplitElem) {
    avgSplitElem.textContent = `${weekdayCases.length} weekday cases / ${businessDaysCount} workdays`;
  }

  const dayMap = {};
  state.filteredCases.forEach((c) => {
    dayMap[c.dateKey] = (dayMap[c.dateKey] || 0) + 1;
  });

  let peakDay = "--";
  let peakCount = 0;
  for (const [day, count] of Object.entries(dayMap)) {
    if (count > peakCount) {
      peakCount = count;
      peakDay = day;
    }
  }

  const peakDayElem = document.getElementById("kpiPeakDay");
  if (peakDayElem) peakDayElem.textContent = peakDay;

  const peakCountElem = document.getElementById("kpiPeakCount");
  if (peakCountElem) peakCountElem.textContent = `${peakCount} tickets peak velocity`;

  const nowMs = Date.now();
  const agingCases = state.filteredCases.filter((c) => {
    const s = (c.status || "").toLowerCase();
    const isNewOrAssigned = s === "new" || s === "assigned";
    const ageMs = nowMs - c.routedDate.getTime();
    return isNewOrAssigned && ageMs > 24 * 60 * 60 * 1000;
  });

  const agingElem = document.getElementById("kpiAgingCases");
  if (agingElem) agingElem.textContent = agingCases.length.toLocaleString();

  const agingSub = document.getElementById("kpiAgingSubtext");
  if (agingSub) {
    agingSub.textContent = `${agingCases.length} open cases breaching 24h SLA`;
  }

  // Keep the exact cases behind each card so a click can list them
  state.kpiCases = {
    total: state.filteredCases,
    weekday: weekdayCases,
    peak: peakCount > 0 ? state.filteredCases.filter((c) => c.dateKey === peakDay) : [],
    aging: agingCases
  };
  state.kpiMeta = { dailyAvg, workdays: businessDaysCount, peakDay, peakCount };
}

function renderDailyInflowChart() {
  const canvas = document.getElementById("dailyInflowChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (state.charts.daily) state.charts.daily.destroy();

  const dateKeys = [];
  const now = new Date();

  if (state.timeRange === "thisMonth") {
    const todayDate = now.getDate();
    for (let day = 1; day <= todayDate; day++) {
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else if (state.timeRange === "lastMonth") {
    const totalDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    for (let day = 1; day <= totalDays; day++) {
      const d = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else if (state.timeRange === "bothMonths") {
    const totalDaysPrev = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    for (let day = 1; day <= totalDaysPrev; day++) {
      const d = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
    const todayDate = now.getDate();
    for (let day = 1; day <= todayDate; day++) {
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else if (state.timeRange === "rolling30") {
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else if (state.timeRange === "custom" && state.customStart && state.customEnd) {
    const cur = parseLocalDate(state.customStart);
    const last = parseLocalDate(state.customEnd);
    while (cur <= last) {
      dateKeys.push(cur.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
      cur.setDate(cur.getDate() + 1);
    }
  } else if (state.timeRange.startsWith("pastWeek")) {
    const weekNum = parseInt(state.timeRange.replace("pastWeek", ""), 10);
    const startOffset = weekNum * 7 - 1;
    const endOffset = (weekNum - 1) * 7;
    for (let i = startOffset; i >= endOffset; i--) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  }

  const countsMap = {};
  dateKeys.forEach((k) => (countsMap[k] = 0));
  state.filteredCases.forEach((c) => {
    if (countsMap[c.dateKey] !== undefined) countsMap[c.dateKey]++;
  });

  const dataCounts = dateKeys.map((k) => countsMap[k]);

  const movingAvg = [];
  for (let i = 0; i < dataCounts.length; i++) {
    const start = Math.max(0, i - 6);
    const windowVals = dataCounts.slice(start, i + 1);
    movingAvg.push(Math.round(windowVals.reduce((a, b) => a + b, 0) / windowVals.length));
  }

  const datasets = [
    {
      type: "bar",
      label: "Inflow Tickets",
      data: dataCounts,
      backgroundColor: SF_COLORS.blue,
      borderRadius: 4
    }
  ];

  if (state.showMovingAverage) {
    datasets.push({
      type: "line",
      label: "7-Day Moving Avg",
      data: movingAvg,
      borderColor: SF_COLORS.orange,
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0.3
    });
  }

  state.charts.daily = new Chart(ctx, {
    data: { labels: dateKeys, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: SF_COLORS.gridLines }, beginAtZero: true }
      }
    }
  });
}

/**
 * High-Contrast Vibrant Status Donut Chart with Bi-Directional Filter Sync
 */
function renderStatusChart() {
  const canvas = document.getElementById("statusChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (state.charts.status) state.charts.status.destroy();

  const statusCounts = {};
  state.filteredCases.forEach((c) => {
    const s = c.status || "Unknown";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  const labels = Object.keys(statusCounts);
  const data = Object.values(statusCounts);

  const bgColors = labels.map((status, idx) => {
    return VIBRANT_STATUS_PALETTE[status] || FALLBACK_VIBRANT_COLORS[idx % FALLBACK_VIBRANT_COLORS.length];
  });

  state.charts.status = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: labels,
      datasets: [
        {
          data: data,
          backgroundColor: bgColors,
          borderWidth: labels.map((l) => (l === state.selectedStatusFilter ? 4 : 2)),
          borderColor: labels.map((l) => (l === state.selectedStatusFilter ? "#1E293B" : "#FFFFFF")),
          hoverOffset: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      onHover: (event, chartElement) => {
        event.native.target.style.cursor = chartElement.length ? "pointer" : "default";
      },
      onClick: (event, elements) => {
        if (elements && elements.length > 0) {
          const index = elements[0].index;
          const clickedStatus = labels[index];
          
          // Toggle between clicked status and default ACTIVE view
          state.selectedStatusFilter = state.selectedStatusFilter === clickedStatus ? "ACTIVE" : clickedStatus;
          
          // Synchronize dropdown element
          const statusDropdown = document.getElementById("statusFilter");
          if (statusDropdown) statusDropdown.value = state.selectedStatusFilter;

          renderTable();
          renderStatusChart();

          // A status was picked (not cleared): bring the matching cases into view
          if (state.selectedStatusFilter !== "ACTIVE") scrollToCases();
        }
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            usePointStyle: true,
            pointStyle: "circle",
            padding: 12,
            font: { weight: "600", size: 12 }
          }
        },
        tooltip: {
          backgroundColor: "#1E293B",
          padding: 10,
          titleFont: { weight: "700" },
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${ctx.raw} cases (${((ctx.raw / (data.reduce((a, b) => a + b, 0) || 1)) * 100).toFixed(1)}%)`
          }
        }
      }
    }
  });
}

// Smoothly scrolls the page down to the cases list (the sticky header is allowed for in CSS)
function scrollToCases() {
  const target = document.querySelector(".table-section") || document.getElementById("casesTableBody");
  if (!target) return;
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

function renderHourlyCurveChart() {
  const canvas = document.getElementById("hourlyChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (state.charts.hourly) state.charts.hourly.destroy();

  const hourlyCounts = new Array(24).fill(0);
  state.filteredCases.forEach((c) => {
    if (c.hourOfDay >= 0 && c.hourOfDay < 24) hourlyCounts[c.hourOfDay]++;
  });

  state.charts.hourly = new Chart(ctx, {
    type: "line",
    data: {
      labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`),
      datasets: [
        {
          label: "Tickets Routed",
          data: hourlyCounts,
          borderColor: SF_COLORS.green,
          backgroundColor: "rgba(46, 132, 74, 0.1)",
          fill: true,
          tension: 0.4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: SF_COLORS.gridLines }, beginAtZero: true }
      }
    }
  });
}

// "Other (Problem)" for cases whose type is outside the four standard ones
function typeLabel(c) {
  return c.type === "Other" && c.rawType ? `Other (${c.rawType})` : c.type;
}

/* =========================================================================
 * Agent workload table
 * Has its own timeframe. "Same as dashboard" (default) uses exactly the cases
 * behind the KPI cards, so the totals are identical by construction.
 * Every case lands in exactly one row: a queue agent, Unassigned, or Others.
 * ========================================================================= */

const UNASSIGNED_KEY = "__UNASSIGNED__";
const OTHERS_KEY = "__OTHERS__";
const AGENT_TYPES = ["Incident", "Service Request", "Query", "Feature Request", "Other"];

function caseGroupKey(c, members) {
  if (c.agent === "Unassigned") return UNASSIGNED_KEY;
  return members.has(c.agent) ? c.agent : OTHERS_KEY;
}

function getAgentBaseCases() {
  if (state.agentRange === "SAME") return state.filteredCases;
  const f = getFilterCriteria();
  return (state.agentCases || []).filter((c) => caseMatchesFilters(c, f));
}

function getAgentWindowText() {
  const text =
    state.agentRange === "SAME"
      ? describeWindow(state.timeRange, state.customStart, state.customEnd)
      : describeWindow(state.agentRange, state.agentCustomStart, state.agentCustomEnd);
  return text.replace(/^Window:\s*/, "");
}

function renderAgentWorkloadTable() {
  const tbody = document.getElementById("agentWorkloadTableBody");
  const tfoot = document.getElementById("agentWorkloadTableFoot");
  if (!tbody || !tfoot) return;

  tbody.innerHTML = "";
  tfoot.innerHTML = "";

  const base = getAgentBaseCases();
  const agentList = state.queueAgents || [];
  const members = new Set(agentList);

  // Count every case into exactly one row and one type column
  const tally = {};
  base.forEach((c) => {
    const key = caseGroupKey(c, members);
    const row = tally[key] || (tally[key] = { total: 0 });
    row[c.type] = (row[c.type] || 0) + 1;
    row.total++;
  });

  const rows = agentList.map((a) => ({ key: a, label: a, muted: false }));
  if ((tally[UNASSIGNED_KEY] || {}).total > 0) {
    rows.push({ key: UNASSIGNED_KEY, label: "Unassigned (still in queue)", muted: true });
  }
  if ((tally[OTHERS_KEY] || {}).total > 0) {
    rows.push({ key: OTHERS_KEY, label: "Others (not on queue roster)", muted: true });
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #888; padding: 15px;">No cases in this timeframe.</td></tr>`;
    return;
  }

  const pillClass = {
    Incident: "pill-low",
    "Service Request": "pill-medium",
    Query: "pill-high",
    "Feature Request": "pill-critical",
    Other: "pill-other"
  };
  const colTotals = { Total: 0 };
  AGENT_TYPES.forEach((t) => (colTotals[t] = 0));

  rows.forEach((row) => {
    const counts = tally[row.key] || { total: 0 };
    const safeKey = escapeHtml(row.key);
    const safeLabel = escapeHtml(row.label);

    AGENT_TYPES.forEach((t) => (colTotals[t] += counts[t] || 0));
    colTotals.Total += counts.total;

    const typeCell = (t) =>
      (counts[t] || 0) > 0
        ? `<td style="text-align: center;"><button type="button" class="pill ${pillClass[t]} drill-link" data-agent="${safeKey}" data-type="${t}" title="View ${counts[t]} ${t} case(s) - ${safeLabel}">${counts[t]}</button></td>`
        : `<td style="text-align: center;">0</td>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><button type="button" class="agent-link${row.muted ? " agent-link-muted" : ""}" data-agent="${safeKey}" title="View all tickets - ${safeLabel}">${safeLabel}</button></td>
      ${AGENT_TYPES.map(typeCell).join("")}
      <td style="text-align: center; font-weight: 700;">${
        counts.total > 0
          ? `<button type="button" class="drill-link-total" data-agent="${safeKey}" title="View all ${counts.total} case(s) - ${safeLabel}">${counts.total}</button>`
          : "0"
      }</td>
    `;
    tbody.appendChild(tr);
  });

  const footCell = (count, type, extraStyle = "") =>
    count > 0
      ? `<td style="text-align: center; ${extraStyle}"><button type="button" class="drill-link-total" ${type ? `data-type="${type}"` : ""} title="View ${count} case(s)">${count}</button></td>`
      : `<td style="text-align: center; ${extraStyle}">0</td>`;

  tfoot.innerHTML = `
    <tr>
      <td>Total</td>
      ${AGENT_TYPES.map((t) => footCell(colTotals[t], t)).join("")}
      ${footCell(colTotals.Total, "", "font-size: 15px;")}
    </tr>
  `;
}

// Line under the table: the window, the total, and whether it matches Total Inflow
function renderAgentNote() {
  // Keep the "Same as dashboard" option label in step with the dashboard timeframe
  const sel = document.getElementById("agentTimeframeSelect");
  if (sel && sel.options.length) {
    const names = {
      thisMonth: "Current Month",
      lastMonth: "Last Calendar Month",
      bothMonths: "Last & Current Months",
      rolling30: "Rolling 30 Days",
      custom: "Custom Range"
    };
    const t = state.timeRange;
    const name = names[t] || (String(t).startsWith("pastWeek") ? `Past Week ${String(t).replace("pastWeek", "")}` : t);
    sel.options[0].text = `Same as dashboard (${name})`;
  }

  const card = document.getElementById("agentWorkloadCard");
  if (card) card.classList.toggle("agent-card-loading", !!state.agentLoading);

  const el = document.getElementById("agentReconcile");
  if (!el) return;

  if (state.agentLoading) {
    el.innerHTML = "Loading cases for this timeframe...";
    return;
  }
  if (state.agentError) {
    el.innerHTML = `<span class="custom-range-error">Could not load this timeframe: ${escapeHtml(state.agentError)}</span>`;
    return;
  }

  const n = getAgentBaseCases().length;
  const windowText = escapeHtml(getAgentWindowText());
  el.innerHTML =
    state.agentRange === "SAME"
      ? `<strong>${n}</strong> cases &bull; ${windowText} &bull; &#10003; Matches Total Inflow above`
      : `<strong>${n}</strong> cases &bull; ${windowText} &bull; Different timeframe from the dashboard, so this total can differ from Total Inflow`;
}

async function loadAgentCases() {
  if (state.agentLoadController) state.agentLoadController.abort();
  state.agentLoadController = null;

  if (state.agentRange === "SAME") {
    state.agentCases = null;
    state.agentLoading = false;
    state.agentError = "";
    renderAgentWorkloadTable();
    renderAgentNote();
    return;
  }

  const controller = new AbortController();
  state.agentLoadController = controller;
  state.agentLoading = true;
  state.agentError = "";
  renderAgentNote();

  try {
    let url = `/api/queue-inflow?queueName=${encodeURIComponent(state.queueName)}&range=${state.agentRange}`;
    if (state.agentRange === "custom") {
      url += `&start=${state.agentCustomStart}&end=${state.agentCustomEnd}`;
    }
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body && body.error) msg = body.error;
      } catch (e) { /* keep the HTTP status */ }
      throw new Error(msg);
    }
    const data = await response.json();
    if (!data.records || !Array.isArray(data.records)) throw new Error("Invalid response payload structure");
    state.agentCases = data.records.map(mapRecord);
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer request
    state.agentCases = [];
    state.agentError = err.message;
  }

  if (state.agentLoadController === controller) {
    state.agentLoadController = null;
    state.agentLoading = false;
    renderAgentWorkloadTable();
    renderAgentNote();
  }
}

function setupAgentTimeframeListeners() {
  const select = document.getElementById("agentTimeframeSelect");
  if (!select) return;
  const controls = document.getElementById("agentCustomControls");
  const startInput = document.getElementById("agentCustomStartDate");
  const endInput = document.getElementById("agentCustomEndDate");
  const errorElem = document.getElementById("agentCustomError");
  const applyBtn = document.getElementById("applyAgentCustomBtn");

  const toISODate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (startInput && endInput) {
    const today = toISODate(new Date());
    startInput.max = today;
    endInput.max = today;
  }

  select.addEventListener("change", async (e) => {
    if (e.target.value === "custom") {
      // Wait for Apply; keep the current table on screen until then
      if (controls) controls.hidden = false;
      if (startInput) startInput.focus();
      return;
    }
    if (controls) controls.hidden = true;
    if (errorElem) errorElem.textContent = "";
    state.agentRange = e.target.value;
    await loadAgentCases();
  });

  if (applyBtn) {
    applyBtn.addEventListener("click", async () => {
      const s = startInput.value;
      const e = endInput.value;
      errorElem.textContent = "";

      if (!s || !e) { errorElem.textContent = "Pick both a start and an end date."; return; }
      if (s > e) { errorElem.textContent = "Start date must be on or before the end date."; return; }
      const days = (parseLocalDate(e) - parseLocalDate(s)) / 86400000 + 1;
      if (days > 365) { errorElem.textContent = "Range cannot exceed 365 days."; return; }

      state.agentRange = "custom";
      state.agentCustomStart = s;
      state.agentCustomEnd = e;
      await loadAgentCases();
    });
  }
}

function renderTable() {
  const tbody = document.getElementById("casesTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const filterIndicator = document.getElementById("statusFilterIndicator");
  const activeStatusLabel = document.getElementById("activeStatusLabel");

  let displayedCases = [];

  if (state.selectedStatusFilter === "ALL") {
    // 1. View All Cases
    displayedCases = state.filteredCases;
    if (filterIndicator) {
      filterIndicator.style.display = "inline-flex";
      activeStatusLabel.textContent = "All Cases";
    }
  } else if (state.selectedStatusFilter && state.selectedStatusFilter !== "ACTIVE") {
    // 2. Specific status selected (from donut or dropdown)
    displayedCases = state.filteredCases.filter(
      (c) => (c.status || "").toLowerCase() === state.selectedStatusFilter.toLowerCase()
    );
    if (filterIndicator) {
      filterIndicator.style.display = "inline-flex";
      activeStatusLabel.textContent = state.selectedStatusFilter;
    }
  } else {
    // 3. Default view: Active queue tickets (New / Assigned)
    displayedCases = state.filteredCases.filter((c) => {
      const s = (c.status || "").toLowerCase();
      return s === "new" || s === "assigned";
    });
    if (filterIndicator) {
      filterIndicator.style.display = "none";
    }
  }

  const countElem = document.getElementById("recordCountText");
  if (countElem) {
    let filterDesc = "New / Assigned";
    if (state.selectedStatusFilter === "ALL") filterDesc = "All Statuses";
    else if (state.selectedStatusFilter && state.selectedStatusFilter !== "ACTIVE") {
      filterDesc = `Status: ${state.selectedStatusFilter}`;
    }
    countElem.textContent = `Showing ${Math.min(200, displayedCases.length)} of ${displayedCases.length} (${filterDesc})`;
  }

  const displayList = displayedCases.slice(0, 200);

  if (displayList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #888; padding: 25px;">No cases found matching the active filters.</td></tr>`;
    return;
  }

  const nowMs = Date.now();

  displayList.forEach((c) => {
    const tr = document.createElement("tr");
    const pClass = String(c.priority || "medium").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const ageHours = Math.floor((nowMs - c.routedDate.getTime()) / (1000 * 60 * 60));
    const isAgingBreach = ageHours >= 24;

    tr.innerHTML = `
      <td>${caseNumberHtml(c)}</td>
      <td>${escapeHtml(c.subject)}</td>
      <td><strong>${escapeHtml(c.agent)}</strong></td>
      <td><span class="pill pill-medium">${escapeHtml(typeLabel(c))}</span></td>
      <td><span class="pill pill-${pClass}">${escapeHtml(c.priority)}</span></td>
      <td>${escapeHtml(c.origin)}</td>
      <td>
        ${c.routedDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })} 
        ${isAgingBreach ? `<span class="pill pill-critical" style="margin-left: 5px;">${ageHours}h</span>` : `<span style="color: #666; font-size: 12px;">(${ageHours}h)</span>`}
      </td>
      <td><span class="pill ${String(c.status).toLowerCase() === 'new' ? 'pill-high' : 'pill-medium'}">${escapeHtml(c.status)}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function getFilterCriteria() {
  const searchInput = document.getElementById("searchInput");
  const priorityFilter = document.getElementById("priorityFilter");
  const originFilter = document.getElementById("originFilter");

  return {
    term: (searchInput ? searchInput.value : "").toLowerCase(),
    selPriority: priorityFilter ? priorityFilter.value : "ALL",
    selOrigin: originFilter ? originFilter.value : "ALL"
  };
}

function caseMatchesFilters(c, f) {
  const matchesTab = state.selectedTab === "ALL" || c.type === state.selectedTab;
  const matchesSearch =
    c.caseNumber.toLowerCase().includes(f.term) ||
    c.subject.toLowerCase().includes(f.term) ||
    c.agent.toLowerCase().includes(f.term) ||
    c.type.toLowerCase().includes(f.term);
  const matchesPriority = f.selPriority === "ALL" || (c.priority || "").toLowerCase() === f.selPriority.toLowerCase();
  const matchesOrigin = f.selOrigin === "ALL" || (c.origin || "").toLowerCase() === f.selOrigin.toLowerCase();

  return matchesTab && matchesSearch && matchesPriority && matchesOrigin;
}

function applyFilters() {
  const f = getFilterCriteria();
  state.filteredCases = state.cases.filter((c) => caseMatchesFilters(c, f));
  renderDashboard();
}

function setupEventListeners() {
  document.querySelectorAll(".tab-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedTab = btn.getAttribute("data-tab");
      applyFilters();
    });
  });

  const statusFilter = document.getElementById("statusFilter");
  if (statusFilter) {
    statusFilter.addEventListener("change", (e) => {
      state.selectedStatusFilter = e.target.value;
      renderTable();
      renderStatusChart();
    });
  }

  // ---- Timeframe + custom date range ----
  const customControls = document.getElementById("customRangeControls");
  const startInput = document.getElementById("customStartDate");
  const endInput = document.getElementById("customEndDate");
  const customError = document.getElementById("customRangeError");
  const applyCustomBtn = document.getElementById("applyCustomRangeBtn");

  const toISODate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (startInput && endInput) {
    const today = toISODate(new Date());
    startInput.max = today;
    endInput.max = today;
  }

  const timeSelect = document.getElementById("timeRangeSelect");
  if (timeSelect) {
    timeSelect.addEventListener("change", async (e) => {
      if (e.target.value === "custom") {
        // Wait for Apply; keep the current data on screen until then
        if (customControls) customControls.hidden = false;
        if (startInput) startInput.focus();
        return;
      }
      if (customControls) customControls.hidden = true;
      if (customError) customError.textContent = "";
      state.timeRange = e.target.value;
      await loadDashboardData();
    });
  }

  if (applyCustomBtn) {
    applyCustomBtn.addEventListener("click", async () => {
      const s = startInput.value;
      const e = endInput.value;
      customError.textContent = "";

      if (!s || !e) { customError.textContent = "Pick both a start and an end date."; return; }
      if (s > e) { customError.textContent = "Start date must be on or before the end date."; return; }
      const days = (parseLocalDate(e) - parseLocalDate(s)) / 86400000 + 1;
      if (days > 365) { customError.textContent = "Range cannot exceed 365 days."; return; }

      state.timeRange = "custom";
      state.customStart = s;
      state.customEnd = e;
      await loadDashboardData();
    });
  }

  const toggleMa = document.getElementById("toggleMa");
  if (toggleMa) {
    toggleMa.addEventListener("change", (e) => {
      state.showMovingAverage = e.target.checked;
      renderDailyInflowChart();
    });
  }

  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters, 200);
    });
  }

  const priorityFilter = document.getElementById("priorityFilter");
  if (priorityFilter) priorityFilter.addEventListener("change", applyFilters);

  const originFilter = document.getElementById("originFilter");
  if (originFilter) originFilter.addEventListener("change", applyFilters);

  const clearStatusBtn = document.getElementById("clearStatusFilterBtn");
  if (clearStatusBtn) {
    clearStatusBtn.addEventListener("click", () => {
      state.selectedStatusFilter = "ACTIVE";
      const sf = document.getElementById("statusFilter");
      if (sf) sf.value = "ACTIVE";
      renderTable();
      renderStatusChart();
    });
  }

  const refreshBtn = document.getElementById("refreshDataBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadDashboardData());
  }

  setupAgentTimeframeListeners();
  setupDrillDownListeners();

  const exportBtn = document.getElementById("exportCsvBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportToCSV);

  const fileInput = document.getElementById("csvFileInput");
  if (fileInput) fileInput.addEventListener("change", handleFileUpload);
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const content = e.target.result;
      if (file.name.endsWith(".json")) {
        const parsed = JSON.parse(content);
        const records = Array.isArray(parsed) ? parsed : parsed.records || [];
        mapIncomingRecords(records);
      } else {
        parseCSV(content);
      }
      populateStatusFilterOptions();
      alert(`Imported ${state.cases.length} records successfully.`);
    } catch (err) {
      alert("Error reading file: " + err.message);
    }
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return;
  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));

  const records = lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/"/g, ""));
    const row = {};
    headers.forEach((h, idx) => (row[h] = values[idx]));
    return row;
  });

  mapIncomingRecords(records);
}

function exportToCSV() {
  const activeCases = state.filteredCases.filter((c) => {
    const s = (c.status || "").toLowerCase();
    if (state.selectedStatusFilter === "ALL") return true;
    if (state.selectedStatusFilter && state.selectedStatusFilter !== "ACTIVE") {
      return s === state.selectedStatusFilter.toLowerCase();
    }
    return s === "new" || s === "assigned";
  });

  const rangeTag =
    state.timeRange === "custom" ? `${state.customStart}_to_${state.customEnd}` : state.timeRange;
  downloadCasesCsv(activeCases, `queue_backlog_${slugify(state.selectedTab)}_${rangeTag}.csv`);
}

/* =========================================================================
 * Shared helpers
 * ========================================================================= */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function slugify(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "cases";
}

function isOpenStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "new" || s === "assigned";
}

function formatAge(hours) {
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Case number as a link to the record in Salesforce when we know the org URL
function caseNumberHtml(c) {
  const label = escapeHtml(c.caseNumber);
  if (state.instanceUrl && /^[a-zA-Z0-9]{15,18}$/.test(String(c.id))) {
    const href = `${state.instanceUrl.replace(/\/+$/, "")}/lightning/r/Case/${c.id}/view`;
    return `<a class="case-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open in Salesforce">${label}</a>`;
  }
  return `<strong>${label}</strong>`;
}

function csvCell(value) {
  let s = String(value ?? "");
  // Stop spreadsheet apps from running cell contents as formulas
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCasesCsv(cases, filename) {
  const headers = ["CaseNumber", "Subject", "Assigned Agent", "Type", "Priority", "Origin", "RoutedDate", "AgeHours", "Status"];
  const nowMs = Date.now();

  const lines = [headers.map(csvCell).join(",")];
  cases.forEach((c) => {
    const ageHours = Math.floor((nowMs - c.routedDate.getTime()) / (1000 * 60 * 60));
    lines.push(
      [
        c.caseNumber,
        c.subject,
        c.agent || "Unassigned",
        typeLabel(c),
        c.priority,
        c.origin,
        c.routedDate.toISOString(),
        ageHours,
        c.status
      ].map(csvCell).join(",")
    );
  });

  // BOM so Excel reads UTF-8 correctly; Blob avoids the data-URL '#' truncation problem
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* =========================================================================
 * Drill-down: KPI cards + agent workload -> case list modal
 * ========================================================================= */

const DRILL_ROW_LIMIT = 500;
const DRILL_TYPE_ORDER = ["Incident", "Service Request", "Query", "Feature Request", "Other"];

function setupDrillDownListeners() {
  // KPI cards
  document.querySelectorAll(".kpi-card[data-kpi]").forEach((card) => {
    const open = () => {
      if (document.body.classList.contains("is-loading")) return;
      openKpiDrill(card.dataset.kpi);
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });

  // Agent workload table (names, per-type counts, totals, footer totals)
  ["agentWorkloadTableBody", "agentWorkloadTableFoot"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", (e) => {
      const btn = e.target.closest("button.agent-link, button.drill-link, button.drill-link-total");
      if (!btn) return;
      openAgentDrill(btn.dataset.agent || "", btn.dataset.type || "");
    });
  });

  // Modal chrome
  const modal = document.getElementById("drillModal");
  if (!modal) return;

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeDrill();
  });

  const closeBtn = document.getElementById("drillCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeDrill);
  const closeFooterBtn = document.getElementById("drillCloseFooterBtn");
  if (closeFooterBtn) closeFooterBtn.addEventListener("click", closeDrill);

  const search = document.getElementById("drillSearch");
  if (search) {
    search.addEventListener("input", (e) => {
      state.drill.search = e.target.value;
      renderDrill();
    });
  }

  const chips = document.getElementById("drillChips");
  if (chips) {
    chips.addEventListener("click", (e) => {
      const chip = e.target.closest(".drill-chip");
      if (!chip) return;
      state.drill.type = chip.dataset.type;
      renderDrill();
    });
  }

  const thead = modal.querySelector("thead");
  if (thead) {
    const sortBy = (th) => {
      const key = th.dataset.sort;
      if (!key) return;
      const d = state.drill;
      if (d.sortKey === key) {
        d.sortDir = d.sortDir === "asc" ? "desc" : "asc";
      } else {
        d.sortKey = key;
        d.sortDir = key === "routedDate" ? "desc" : "asc";
      }
      renderDrill();
    };
    thead.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (th) sortBy(th);
    });
    thead.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const th = e.target.closest("th[data-sort]");
      if (th) {
        e.preventDefault();
        sortBy(th);
      }
    });
  }

  const exportBtn = document.getElementById("drillExportBtn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      downloadCasesCsv(getDrillVisibleCases(), `${slugify(state.drill.title)}.csv`);
    });
  }

  // Esc closes; Tab stays inside the dialog
  document.addEventListener("keydown", (e) => {
    if (!modal.classList.contains("open")) return;
    if (e.key === "Escape") {
      closeDrill();
      return;
    }
    if (e.key === "Tab") {
      const focusable = Array.from(
        modal.querySelectorAll("button, input, select, a[href], th[tabindex='0']")
      ).filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

function openKpiDrill(kind) {
  const cases = (state.kpiCases && state.kpiCases[kind]) || [];
  const m = state.kpiMeta || {};
  const windowElem = document.getElementById("dateRangeText");
  const windowText = (windowElem ? windowElem.textContent : "").replace(/^Window:\s*/, "");
  const n = cases.length;
  const noun = n === 1 ? "case" : "cases";

  let title = "Cases";
  let subtitle = "";

  switch (kind) {
    case "total":
      title = "Total Inflow";
      subtitle = `${n} ${noun} routed into the queue • ${windowText}`;
      break;
    case "weekday":
      title = "Daily Workday Average";
      subtitle = `${n} weekday ${noun} ÷ ${m.workdays} workdays = ${m.dailyAvg} per day • Weekend cases are excluded`;
      break;
    case "peak":
      title = `Peak Arrival Day — ${m.peakDay || "--"}`;
      subtitle = `${n} ${noun} arrived on the busiest day of this window`;
      break;
    case "aging":
      title = "Aging Cases (> 24h)";
      subtitle = `${n} open (New / Assigned) ${noun} older than 24 hours`;
      break;
  }

  if (state.selectedTab !== "ALL") subtitle += ` • Filtered to ${state.selectedTab}`;
  openDrill(title, subtitle, cases);
}

function openAgentDrill(key, type) {
  const members = new Set(state.queueAgents || []);
  const cases = getAgentBaseCases().filter(
    (c) => (!key || caseGroupKey(c, members) === key) && (!type || c.type === type)
  );

  let title;
  if (key === UNASSIGNED_KEY) title = "Unassigned cases";
  else if (key === OTHERS_KEY) title = "Cases owned by people outside the queue roster";
  else title = key || "All cases";
  if (type) title += ` — ${type}`;

  const noun = cases.length === 1 ? "case" : "cases";
  openDrill(title, `${cases.length} ${noun} • ${getAgentWindowText()}`, cases);
}

function openDrill(title, subtitle, cases) {
  const modal = document.getElementById("drillModal");
  if (!modal) return;

  const d = state.drill;
  d.title = title;
  d.cases = cases;
  d.search = "";
  d.type = "ALL";
  d.sortKey = "routedDate";
  d.sortDir = "desc";
  d.lastFocus = document.activeElement;

  document.getElementById("drillTitle").textContent = title;
  document.getElementById("drillSubtitle").textContent = subtitle;
  const search = document.getElementById("drillSearch");
  if (search) search.value = "";

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  renderDrill();
  if (search) search.focus();
}

function closeDrill() {
  const modal = document.getElementById("drillModal");
  if (!modal || !modal.classList.contains("open")) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  const prev = state.drill.lastFocus;
  if (prev && typeof prev.focus === "function") prev.focus();
}

function getDrillVisibleCases() {
  const d = state.drill;
  const term = d.search.trim().toLowerCase();

  const list = d.cases.filter((c) => {
    if (d.type !== "ALL" && c.type !== d.type) return false;
    if (!term) return true;
    return [c.caseNumber, c.subject, c.agent, c.type, c.rawType, c.status, c.priority].some((v) =>
      String(v || "").toLowerCase().includes(term)
    );
  });

  const dir = d.sortDir === "asc" ? 1 : -1;
  const valueOf = (c) =>
    d.sortKey === "routedDate" ? c.routedDate.getTime() : String(c[d.sortKey] || "").toLowerCase();

  list.sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (x < y) return -1 * dir;
    if (x > y) return 1 * dir;
    return 0;
  });

  return list;
}

function renderDrill() {
  const d = state.drill;

  // Type chips (with counts) built from the full list for this drill-down
  const typeCounts = {};
  d.cases.forEach((c) => {
    typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
  });
  const rank = (t) => {
    const i = DRILL_TYPE_ORDER.indexOf(t);
    return i === -1 ? 99 : i;
  };
  const chipDefs = [["ALL", `All (${d.cases.length})`]].concat(
    Object.keys(typeCounts)
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((t) => [t, `${t} (${typeCounts[t]})`])
  );
  const chipsElem = document.getElementById("drillChips");
  if (chipsElem) {
    chipsElem.innerHTML = chipDefs
      .map(
        ([val, label]) =>
          `<button type="button" class="drill-chip${d.type === val ? " active" : ""}" data-type="${escapeHtml(val)}">${escapeHtml(label)}</button>`
      )
      .join("");
  }

  // Sort indicators
  document.querySelectorAll("#drillModal th[data-sort]").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === d.sortKey) th.classList.add(d.sortDir === "asc" ? "sorted-asc" : "sorted-desc");
  });

  const visible = getDrillVisibleCases();
  const shown = visible.slice(0, DRILL_ROW_LIMIT);

  const countElem = document.getElementById("drillCount");
  if (countElem) {
    countElem.textContent =
      visible.length > DRILL_ROW_LIMIT
        ? `Showing first ${DRILL_ROW_LIMIT} of ${visible.length} (export CSV for all)`
        : `Showing ${visible.length} of ${d.cases.length}`;
  }

  const tbody = document.getElementById("drillTableBody");
  if (!tbody) return;

  if (shown.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #888; padding: 25px;">No cases match.</td></tr>`;
    return;
  }

  const nowMs = Date.now();
  const dateOpts = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };

  tbody.innerHTML = shown
    .map((c) => {
      const ageHours = Math.max(0, Math.floor((nowMs - c.routedDate.getTime()) / (1000 * 60 * 60)));
      const ageHtml =
        isOpenStatus(c.status) && ageHours >= 24
          ? `<span class="pill pill-critical">${formatAge(ageHours)}</span>`
          : `<span class="muted-age">${formatAge(ageHours)}</span>`;
      const pClass = String(c.priority || "medium").toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const typeClass = "pill-type-" + String(c.type).toLowerCase().replace(/[^a-z]+/g, "-");

      return `
        <tr>
          <td class="drill-nowrap">${caseNumberHtml(c)}</td>
          <td class="drill-subject">${escapeHtml(c.subject)}</td>
          <td class="drill-nowrap">${escapeHtml(c.agent)}</td>
          <td class="drill-nowrap"><span class="pill ${typeClass}">${escapeHtml(typeLabel(c))}</span></td>
          <td class="drill-nowrap"><span class="pill pill-${pClass}">${escapeHtml(c.priority)}</span></td>
          <td class="drill-nowrap">${escapeHtml(c.status)}</td>
          <td class="drill-nowrap">${escapeHtml(c.routedDate.toLocaleString("en-US", dateOpts))} ${ageHtml}</td>
        </tr>`;
    })
    .join("");
 }