// server.js
process.env.TZ = 'Asia/Kolkata'; // Align Node.js to Salesforce Org timezone (IST)
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const jsforce = require('jsforce');

const app = express();
const PORT = process.env.PORT || 9001;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json());

// Page files live in public/. Vercel serves that folder itself; this line is for running locally.
// (Serving __dirname would also publish server.js, package.json and friends.)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Optional password for the data API. Set DASHBOARD_PASSWORD (and optionally DASHBOARD_USER) to turn it on;
// leave it unset for local use. The browser will ask for the login the first time the dashboard loads data.
const { DASHBOARD_USER = 'admin', DASHBOARD_PASSWORD } = process.env;

function requireLogin(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();

  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
    const userOk = crypto.timingSafeEqual(sha(user), sha(DASHBOARD_USER));
    const passOk = crypto.timingSafeEqual(sha(pass), sha(DASHBOARD_PASSWORD));
    if (userOk && passOk) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Queue Inflow Analytics"');
  return res.status(401).json({ success: false, error: 'Login required' });
}
app.use('/api', requireLogin);

const {
  SF_LOGIN_URL = 'https://greyorangeorg.my.salesforce.com',
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_QUEUE_NAME = 'Admin Queue',
} = process.env;

let cachedConn = null;
let cachedQueue = null;
let caseFieldsCache = null;

// Response cache with "stale-while-revalidate":
//   - an entry is FRESH for ttlSeconds (default 2 min)
//   - after that it is STALE but still served instantly for staleSeconds (default 15 min)
//     while a background refresh runs, so users almost never wait on Salesforce
const responseCache = {
  store: new Map(),
  getEntry(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now > entry.staleUntil) {
      this.store.delete(key);
      return null;
    }
    return { data: entry.data, fresh: now <= entry.freshUntil };
  },
  get(key) {
    const entry = this.getEntry(key);
    return entry && entry.fresh ? entry.data : null;
  },
  set(key, data, ttlSeconds = 120, staleSeconds = 900) {
    // Custom ranges create new keys; cap the cache so it cannot grow forever
    if (this.store.size >= 50) this.store.delete(this.store.keys().next().value);
    const now = Date.now();
    this.store.set(key, {
      data,
      freshUntil: now + ttlSeconds * 1000,
      staleUntil: now + (ttlSeconds + staleSeconds) * 1000,
    });
  },
  delete(key) {
    this.store.delete(key);
  },
};

const inFlightRequests = new Map();

// On Vercel a function can be frozen as soon as the response is sent. waitUntil (from the optional
// @vercel/functions package) keeps it alive until the background refresh finishes. Safe to leave uninstalled.
let vercelWaitUntil = null;
try {
  ({ waitUntil: vercelWaitUntil } = require('@vercel/functions'));
} catch (e) {
  /* not installed: background refreshes still run wherever the process stays alive */
}
const keepAlive = (promise) => {
  if (!vercelWaitUntil) return;
  try {
    vercelWaitUntil(promise);
  } catch (e) {
    /* not running on Vercel */
  }
};

async function getSalesforceConnection(forceRefresh = false) {
  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) {
    throw new Error('Missing SF_CLIENT_ID or SF_CLIENT_SECRET in .env file.');
  }

  if (!forceRefresh && cachedConn && cachedConn.accessToken) {
    return cachedConn;
  }

  const tokenUrl = `${SF_LOGIN_URL.replace(/\/+$/, '')}/services/oauth2/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const tokenData = await response.json();
  if (!response.ok) {
    throw new Error(`Salesforce OAuth Error: ${tokenData.error_description || tokenData.error}`);
  }

  cachedConn = new jsforce.Connection({
    instanceUrl: tokenData.instance_url,
    accessToken: tokenData.access_token,
  });

  return cachedConn;
}

async function getQueueMetadata(conn, targetName) {
  if (cachedQueue && cachedQueue.Name === targetName) {
    return cachedQueue;
  }

  const devName = targetName.replace(/\s+/g, '_');
  const query = `
    SELECT Id, Name, DeveloperName 
    FROM Group 
    WHERE Type = 'Queue' 
    AND (Name = '${targetName}' OR DeveloperName = '${devName}') 
    LIMIT 1
  `;

  const res = await conn.query(query);
  if (!res.records.length) {
    throw new Error(`Queue '${targetName}' not found in Salesforce.`);
  }

  cachedQueue = res.records[0];
  return cachedQueue;
}

async function getCaseTypeFields(conn) {
  if (caseFieldsCache) return caseFieldsCache;
  try {
    const describe = await conn.sobject('Case').describe();
    const fieldNames = new Set(describe.fields.map((f) => f.name));
    caseFieldsCache = {
      hasRecordType: fieldNames.has('RecordTypeId'),
      hasTicketType: fieldNames.has('Ticket_Type__c'),
      hasCaseType: fieldNames.has('Case_Type__c'),
      hasCategory: fieldNames.has('Category__c'),
      hasToolsPlatform: fieldNames.has('Tools_Platform__c'), // "Tool Type" picklist (automation tickets)
    };
    return caseFieldsCache;
  } catch (err) {
    return { hasRecordType: false, hasTicketType: false, hasCaseType: false, hasCategory: false, hasToolsPlatform: false };
  }
}

async function getQueueMembers(conn, queueId) {
  try {
    const memberQuery = `
      SELECT UserOrGroupId 
      FROM GroupMember 
      WHERE GroupId = '${queueId}'
    `;
    const memberRes = await conn.query(memberQuery);
    const userIds = memberRes.records
      .map((r) => r.UserOrGroupId)
      .filter((id) => id && id.startsWith('005'));

    if (userIds.length === 0) return [];

    const userQuery = `
      SELECT Id, Name 
      FROM User 
      WHERE Id IN (${userIds.map((id) => `'${id}'`).join(',')})
      AND IsActive = true
    `;
    const userRes = await conn.query(userQuery);
    return userRes.records.map((u) => u.Name);
  } catch (err) {
    return [];
  }
}

// Queue membership rarely changes, so remember it for a few minutes instead of 2 queries per refresh
const MEMBERS_TTL_MS = 10 * 60 * 1000;
const membersCache = new Map();

async function getQueueMembersCached(conn, queueId) {
  const hit = membersCache.get(queueId);
  if (hit && Date.now() < hit.expiresAt) return hit.names;
  const names = await getQueueMembers(conn, queueId);
  if (names.length > 0) membersCache.set(queueId, { names, expiresAt: Date.now() + MEMBERS_TTL_MS });
  return names;
}

function extractRawType(c) {
  if (c.Type && c.Type !== '--None--' && c.Type.trim() !== '') return c.Type;
  if (c.Category__c && c.Category__c !== '--None--' && c.Category__c.trim() !== '') return c.Category__c;
  if (c.Ticket_Type__c && c.Ticket_Type__c !== '--None--' && c.Ticket_Type__c.trim() !== '') return c.Ticket_Type__c;
  if (c.Case_Type__c && c.Case_Type__c !== '--None--' && c.Case_Type__c.trim() !== '') return c.Case_Type__c;
  if (c.RecordType && c.RecordType.Name && !c.RecordType.Name.toLowerCase().includes('form')) return c.RecordType.Name;
  return '';
}

function normalizeType(rawType, subject = '') {
  const t = String(rawType || '').toLowerCase().trim();
  const s = String(subject || '').toLowerCase().trim();

  if (
    t === 'feature request' ||
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

  if (t === 'service request' || t.includes('service') || t.includes('request') || t === 'sr') {
    return 'Service Request';
  }

  if (t === 'query' || t.includes('query') || t.includes('question') || t.includes('inquiry')) {
    return 'Query';
  }

  if (t === 'incident' || t.includes('incident') || t.includes('issue') || t.includes('bug')) {
    return 'Incident';
  }

  return rawType || 'Incident';
}

function getOrgDateParts(dateInput) {
  const d = new Date(dateInput);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = formatter.formatToParts(d);
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  return {
    year: parseInt(map.year, 10),
    monthIndex: parseInt(map.month, 10) - 1, // 0-indexed month
    day: parseInt(map.day, 10),
  };
}

function generateMonthlyWeekBuckets(year, monthIndex) {
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const lastDayOfMonth = new Date(year, monthIndex + 1, 0).getDate();
  const buckets = [];

  let currentStartDay = 1;
  let weekIndex = 1;

  while (currentStartDay <= lastDayOfMonth) {
    const startDate = new Date(year, monthIndex, currentStartDay);
    const dayOfWeek = startDate.getDay();
    const daysToSunday = (7 - dayOfWeek) % 7;
    const currentEndDay = Math.min(currentStartDay + daysToSunday, lastDayOfMonth);

    const label = `${monthNames[monthIndex]} ${String(currentStartDay).padStart(2, '0')} - ${monthNames[monthIndex]} ${String(currentEndDay).padStart(2, '0')}`;

    buckets.push({
      week: `Week ${weekIndex}`,
      label,
      startDay: currentStartDay,
      endDay: currentEndDay,
      totalInflow: 0,
      typeBreakdown: { Incident: 0, 'Service Request': 0, Query: 0, 'Feature Request': 0 },
      agentBreakdown: {},
    });

    currentStartDay = currentEndDay + 1;
    weekIndex++;
  }

  return buckets;
}

function bifurcateRecordsByWeek(records, weeks, monthName, year, targetMonthIndex) {
  let monthTotal = 0;

  records.forEach((c) => {
    const { day, monthIndex } = getOrgDateParts(c.CreatedDate);
    // If ticket was carried over into active queue from prior month, map to Day 1 of current month
    const evalDay = (targetMonthIndex !== undefined && monthIndex !== targetMonthIndex) ? 1 : day;

    const targetWeek = weeks.find((w) => evalDay >= w.startDay && evalDay <= w.endDay);
    if (targetWeek) {
      targetWeek.totalInflow++;
      monthTotal++;
      c.weekLabel = targetWeek.label;

      const type = normalizeType(c.Type, c.Subject);
      targetWeek.typeBreakdown[type] = (targetWeek.typeBreakdown[type] || 0) + 1;

      const agent = c.agent || 'Unassigned';
      if (agent !== 'Unassigned') {
        if (!targetWeek.agentBreakdown[agent]) {
          targetWeek.agentBreakdown[agent] = {
            Incident: 0,
            'Service Request': 0,
            Query: 0,
            'Feature Request': 0,
            total: 0,
          };
        }
        targetWeek.agentBreakdown[agent][type] = (targetWeek.agentBreakdown[agent][type] || 0) + 1;
        targetWeek.agentBreakdown[agent].total += 1;
      }
    }
  });

  return {
    month: `${monthName} ${year}`,
    totalInflow: monthTotal,
    weeks: weeks.map(({ startDay, endDay, ...rest }) => ({
      ...rest,
      startDate: `${year}-${String(targetMonthIndex + 1).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`,
      endDate: `${year}-${String(targetMonthIndex + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`,
    })),
  };
}

async function queryAllHistory(conn, soqlQuery) {
  let records = [];
  let res = await conn.query(soqlQuery);
  records = records.concat(res.records);
  while (!res.done && res.nextRecordsUrl) {
    res = await conn.queryMore(res.nextRecordsUrl);
    records = records.concat(res.records);
  }
  return records;
}

// Runs tasks with at most `limit` in flight; results keep the order of `tasks`
async function poolAll(tasks, limit = 5) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Owner-change history, fetched in parallel time slices
// ---------------------------------------------------------------------------
// The history query is the heaviest part (every owner change in the org for two months, 2,000 rows per page,
// pages are sequential). Splitting it into windows lets several windows download at once.
// Tune with HISTORY_SLICE_DAYS (0 = one window) and HISTORY_CONCURRENCY in .env if needed.
const HISTORY_SLICE_DAYS = Math.max(0, parseInt(process.env.HISTORY_SLICE_DAYS || '7', 10) || 0);
const HISTORY_CONCURRENCY = Math.max(1, parseInt(process.env.HISTORY_CONCURRENCY || '4', 10) || 4);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;

const soqlDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// Start of a month in org time (IST), as a UTC instant
function orgMonthStart(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, 1) - IST_OFFSET_MS);
}

// Splits [from, to) into windows, NEWEST first, so concatenated results stay newest-first
function sliceWindows(from, to) {
  if (!HISTORY_SLICE_DAYS) return [[from, to]];
  const step = HISTORY_SLICE_DAYS * MS_PER_DAY;
  const windows = [];
  for (let start = from.getTime(); start < to.getTime(); start += step) {
    windows.push([new Date(start), new Date(Math.min(start + step, to.getTime()))]);
  }
  return windows.reverse();
}

async function fetchOwnerHistory(conn, from, to) {
  const base = `SELECT CaseId, Field, OldValue, NewValue, CreatedDate FROM CaseHistory WHERE Field = 'Owner'`;
  const tasks = sliceWindows(from, to).map(([a, b]) => () =>
    queryAllHistory(
      conn,
      `${base} AND CreatedDate >= ${soqlDate(a)} AND CreatedDate < ${soqlDate(b)} ORDER BY CreatedDate DESC`
    )
  );
  const parts = await poolAll(tasks, HISTORY_CONCURRENCY);
  return parts.flat();
}

// ---------------------------------------------------------------------------
// Range handling
// ---------------------------------------------------------------------------
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CUSTOM_DAYS = 365;

// Midnight of a YYYY-MM-DD day in the org timezone (IST)
function parseDay(s) {
  if (typeof s !== 'string' || !ISO_DAY.test(s)) return null;
  const d = new Date(`${s}T00:00:00+05:30`);
  return isNaN(d.getTime()) ? null : d;
}

// Ranges other than the two calendar months derive from the same 2-month dataset,
// so they share one Salesforce fetch/cache entry. Custom ranges that reach further
// back get their own scope ("custom:START:END").
function scopeForRange(rangeParam) {
  if (rangeParam === 'thisMonth' || rangeParam === 'lastMonth') return rangeParam;
  if (typeof rangeParam === 'string' && rangeParam.startsWith('custom:')) return rangeParam;
  return 'bothMonths';
}

// Turns query params into { range, scope, from, to }
function resolveRange(query) {
  const range = query.range || 'thisMonth';
  if (range !== 'custom') return { range, scope: scopeForRange(range) };

  const from = parseDay(query.start);
  const endDay = parseDay(query.end);
  if (!from || !endDay) throw new Error('Custom range needs valid start and end dates (YYYY-MM-DD).');
  if (endDay < from) throw new Error('Start date must be on or before the end date.');

  const to = new Date(endDay.getTime() + 24 * 60 * 60 * 1000); // exclusive end
  if ((to - from) / 86400000 > MAX_CUSTOM_DAYS) {
    throw new Error(`Custom range cannot exceed ${MAX_CUSTOM_DAYS} days.`);
  }

  // Inside the already-fetched two-month dataset? Reuse it.
  const org = getOrgDateParts(new Date());
  const twoMonthStart = new Date(org.year, org.monthIndex - 1, 1); // process TZ is IST
  const scope = from >= twoMonthStart ? 'bothMonths' : `custom:${query.start}:${query.end}`;
  return { range, scope, from, to };
}

async function executeInflowFetch(queueName, rangeParam, isRetry = false) {
  const t0 = Date.now();
  const marks = [];
  const mark = (label) => marks.push(`${label} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  try {
    const conn = await getSalesforceConnection(isRetry);
    const [queue, schemaFields] = await Promise.all([
      getQueueMetadata(conn, queueName),
      getCaseTypeFields(conn),
    ]);
    mark('connect');

    const extraCols = [];
    if (schemaFields.hasRecordType) extraCols.push('RecordType.Name');
    if (schemaFields.hasTicketType) extraCols.push('Ticket_Type__c');
    if (schemaFields.hasCaseType) extraCols.push('Case_Type__c');
    if (schemaFields.hasCategory) extraCols.push('Category__c');
    if (schemaFields.hasToolsPlatform) extraCols.push('Tools_Platform__c');

    const selectClause = [
      'Id', 'CaseNumber', 'Subject', 'Status', 'Automation_Priority__c', 'Type',
      ...extraCols,
      'CreatedDate', 'OwnerId', 'Owner.Name'
    ].join(', ');

    const currentQueueSoql = `
      SELECT ${selectClause} 
      FROM Case 
      WHERE OwnerId = '${queue.Id}' 
      ORDER BY CreatedDate ASC
    `;

    const scope = scopeForRange(rangeParam);
    const customMatch = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(scope);

    // One fetch covers every standard range (this month, last month, both); custom ranges fetch their own window
    let historyFrom;
    let historyTo;
    if (customMatch) {
      historyFrom = parseDay(customMatch[1]);
      historyTo = new Date(parseDay(customMatch[2]).getTime() + MS_PER_DAY);
    } else {
      const orgNow = getOrgDateParts(new Date());
      historyFrom = orgMonthStart(orgNow.year, orgNow.monthIndex - 1);
      historyTo = orgMonthStart(orgNow.year, orgNow.monthIndex + 1);
    }

    // Queue cases, queue members and owner history are independent, so fetch them together
    const [currentRecords, directQueueMembers, historyRecords] = await Promise.all([
      queryAllHistory(conn, currentQueueSoql), // pages through every queue case, not just the first 2,000
      getQueueMembersCached(conn, queue.Id),
      fetchOwnerHistory(conn, historyFrom, historyTo),
    ]);
    mark(`queue cases (${currentRecords.length}) + history (${historyRecords.length})`);

    const caseMap = new Map();
    const caseInflowTimestamps = new Map();
    const caseAgentMap = new Map();
    const detectedHistoricalAgents = new Set(directQueueMembers);
    const rawTypesFound = new Set();

    currentRecords.forEach((c) => {
      const rawT = extractRawType(c);
      if (rawT) rawTypesFound.add(rawT);

      caseMap.set(c.Id, {
        Id: c.Id,
        CaseNumber: c.CaseNumber,
        Subject: c.Subject || '(No Subject)',
        agent: 'Unassigned',
        Status: c.Status,
        Automation_Priority__c: c.Automation_Priority__c || 'Medium',
        Type: normalizeType(rawT, c.Subject),
        Tools_Platform__c: c.Tools_Platform__c || null,
        CreatedDate: c.CreatedDate,
      });
    });

    const qNameLower = queue.Name.toLowerCase().trim();
    const qDevLower = queue.DeveloperName.toLowerCase().trim();
    const q15Id = queue.Id.substring(0, 15).toLowerCase();

    const isTargetQueue = (val) => {
      if (!val) return false;
      const str = String(val).toLowerCase().trim();
      return str === qNameLower || str === qDevLower || str.includes(q15Id);
    };

    const targetCaseIds = new Set();

    historyRecords.forEach((h) => {
      const movedIn = isTargetQueue(h.NewValue);
      const movedOut = isTargetQueue(h.OldValue);

      if (movedIn || movedOut) {
        targetCaseIds.add(h.CaseId);
        if (movedIn && !caseInflowTimestamps.has(h.CaseId)) {
          caseInflowTimestamps.set(h.CaseId, h.CreatedDate);
        }
        if (movedOut && !isTargetQueue(h.NewValue) && h.NewValue && h.NewValue !== 'Automated Process') {
          caseAgentMap.set(h.CaseId, h.NewValue);
          detectedHistoricalAgents.add(h.NewValue);
        }
      }
    });

    // Update inflow timestamps for cases currently waiting in the queue
    currentRecords.forEach((c) => {
      if (caseInflowTimestamps.has(c.Id)) {
        const entry = caseMap.get(c.Id);
        if (entry) {
          entry.CreatedDate = caseInflowTimestamps.get(c.Id);
        }
      }
    });

    const missingCaseIds = Array.from(targetCaseIds).filter((id) => !caseMap.has(id));

    if (missingCaseIds.length > 0) {
      const chunkSize = 200;
      const tasks = [];

      for (let i = 0; i < missingCaseIds.length; i += chunkSize) {
        const chunk = missingCaseIds.slice(i, i + chunkSize);
        const idsFormatted = chunk.map((id) => `'${id}'`).join(',');
        const query = `
          SELECT ${selectClause} 
          FROM Case 
          WHERE Id IN (${idsFormatted})
        `;
        tasks.push(() => conn.query(query));
      }

      const chunkResults = await poolAll(tasks, 5);

      chunkResults.forEach((res) => {
        res.records.forEach((c) => {
          const rawT = extractRawType(c);
          if (rawT) rawTypesFound.add(rawT);

          const ownerName = c.Owner && c.Owner.Name ? c.Owner.Name : null;
          const agentName =
            ownerName && !isTargetQueue(ownerName) && ownerName !== 'Automated Process'
              ? ownerName
              : caseAgentMap.get(c.Id) || 'Unassigned';

          if (agentName !== 'Unassigned') detectedHistoricalAgents.add(agentName);

          caseMap.set(c.Id, {
            Id: c.Id,
            CaseNumber: c.CaseNumber,
            Subject: c.Subject || '(No Subject)',
            agent: agentName,
            Status: c.Status,
            Automation_Priority__c: c.Automation_Priority__c || 'Medium',
            Type: normalizeType(rawT, c.Subject),
            Tools_Platform__c: c.Tools_Platform__c || null,
            CreatedDate: caseInflowTimestamps.get(c.Id) || c.CreatedDate,
          });
        });
      });
    }

    mark(`missing cases (${missingCaseIds.length})`);

    const unifiedRecords = Array.from(caseMap.values());
    // Only actual queue members are reported; historical owners are not part of the roster
    const resolvedQueueAgents = directQueueMembers.filter((name) => name && !isTargetQueue(name));

    // Timezone-Aware Partitioning against Org Now (IST)
    const nowOrg = getOrgDateParts(new Date());
    const currentYear = nowOrg.year;
    const currentMonth = nowOrg.monthIndex;

    const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
    const lastYear = lastMonthDate.getFullYear();
    const lastMonth = lastMonthDate.getMonth();

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];

    const currentMonthBuckets = generateMonthlyWeekBuckets(currentYear, currentMonth);
    const lastMonthBuckets = generateMonthlyWeekBuckets(lastYear, lastMonth);

    const thisMonthRecords = [];
    const lastMonthRecords = [];

    unifiedRecords.forEach((c) => {
      const cOrg = getOrgDateParts(c.CreatedDate);
      const isCurrentMonth = cOrg.year === currentYear && cOrg.monthIndex === currentMonth;
      const isActiveInQueue = c.agent === 'Unassigned' || (c.status && c.status.toLowerCase() === 'new');

      // 1. Current Month includes cases created this month + any active queue case
      if (isCurrentMonth || isActiveInQueue) {
        thisMonthRecords.push(c);
      }

      // 2. Last Month includes tickets created in last month
      if (cOrg.year === lastYear && cOrg.monthIndex === lastMonth) {
        lastMonthRecords.push(c);
      }
    });

    const currentMonthBifurcation = bifurcateRecordsByWeek(
      thisMonthRecords,
      currentMonthBuckets,
      monthNames[currentMonth],
      currentYear,
      currentMonth
    );
    const lastMonthBifurcation = bifurcateRecordsByWeek(
      lastMonthRecords,
      lastMonthBuckets,
      monthNames[lastMonth],
      lastYear,
      lastMonth
    );

    const generatedAt = new Date().toISOString();
    const weeklyBifurcation = {
      currentMonth: currentMonthBifurcation,
      lastMonth: lastMonthBifurcation,
      allWeeks: [
        ...lastMonthBifurcation.weeks.map((w) => ({ ...w, month: lastMonthBifurcation.month })),
        ...currentMonthBifurcation.weeks.map((w) => ({ ...w, month: currentMonthBifurcation.month })),
      ],
    };

    const makePayload = (name, records) => ({
      success: true,
      queueName: queue.Name,
      queueId: queue.Id,
      instanceUrl: conn.instanceUrl,
      range: name,
      queueAgents: resolvedQueueAgents,
      totalSize: records.length,
      records,
      weeklyBifurcation,
      generatedAt,
    });

    // One Salesforce fetch fills the cache for every standard range, so they always agree with each other
    const payloads = customMatch
      ? { [scope]: makePayload(scope, unifiedRecords) }
      : {
          thisMonth: makePayload('thisMonth', thisMonthRecords),
          lastMonth: makePayload('lastMonth', lastMonthRecords),
          bothMonths: makePayload('bothMonths', unifiedRecords),
        };

    Object.entries(payloads).forEach(([name, p]) => responseCache.set(`${queueName}_${name}`, p, 120));

    mark('build');
    console.log(`[FETCH] ${customMatch ? scope : 'all ranges'}: ${unifiedRecords.length} cases | ${marks.join(' | ')}`);
    return payloads;
  } catch (err) {
    if ((err.errorCode === 'INVALID_SESSION_ID' || err.message.includes('Session expired')) && !isRetry) {
      console.warn('[RETRY] Session expired. Refreshing token...');
      cachedConn = null;
      return executeInflowFetch(queueName, rangeParam, true);
    }
    throw err;
  }
}

function applyRangeFilter(payload, spec) {
  const weekMatch = /^pastWeek(\d+)$/.exec(spec.range);
  let from = null;
  let to = null;
  if (spec.range === 'custom') {
    from = spec.from;
    to = spec.to;
  } else if (spec.range === 'rolling30') {
    from = new Date();
    from.setDate(from.getDate() - 30);
  } else if (weekMatch) {
    const n = parseInt(weekMatch[1], 10);
    to = new Date();
    to.setDate(to.getDate() - (n - 1) * 7);
    from = new Date();
    from.setDate(from.getDate() - n * 7);
  } else {
    return payload;
  }
  const isCurrentWeekWindow = weekMatch && weekMatch[1] === '1';
  const records = payload.records.filter((c) => {
    const cd = new Date(c.CreatedDate);
    return cd >= from && (!to || isCurrentWeekWindow || cd < to);
  });
  return { ...payload, range: spec.range, totalSize: records.length, records };
}

// All standard ranges come from one Salesforce fetch, so they share one in-flight request.
// Custom ranges that reach further back fetch (and cache) their own window.
function flightKeyFor(queueName, scope) {
  return scope.startsWith('custom:') ? `${queueName}_${scope}` : `${queueName}_core`;
}

// Starts (or joins) the Salesforce fetch for a scope; resolves to payloads keyed by scope
function startFetch(queueName, scope) {
  const key = flightKeyFor(queueName, scope);
  if (!inFlightRequests.has(key)) {
    inFlightRequests.set(
      key,
      executeInflowFetch(queueName, scope).finally(() => inFlightRequests.delete(key))
    );
  }
  return inFlightRequests.get(key);
}

async function fetchInflowData(queueName = SF_QUEUE_NAME, spec = resolveRange({}), forceRefresh = false) {
  const cacheKey = `${queueName}_${spec.scope}`;

  if (!forceRefresh) {
    const entry = responseCache.getEntry(cacheKey);
    if (entry) {
      // Stale data is still served instantly; refresh quietly in the background
      if (!entry.fresh) {
        const refresh = startFetch(queueName, spec.scope).catch((err) =>
          console.warn('[BACKGROUND REFRESH WARNING]', err.message)
        );
        keepAlive(refresh);
      }
      return applyRangeFilter(entry.data, spec);
    }
  }

  const payloads = await startFetch(queueName, spec.scope);
  return applyRangeFilter(payloads[spec.scope], spec);
}

app.get('/api/queue-inflow', async (req, res) => {
  const queueName = req.query.queueName || SF_QUEUE_NAME;
  const forceRefresh = req.query.refresh === 'true';

  let spec;
  try {
    spec = resolveRange(req.query);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  if (forceRefresh) {
    responseCache.delete(`${queueName}_${spec.scope}`);
  }

  try {
    const payload = await fetchInflowData(queueName, spec, forceRefresh);
    return res.json(payload);
  } catch (err) {
    console.error('Error handling /api/queue-inflow:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const conn = await getSalesforceConnection();
    res.json({ status: 'ok', salesforce: 'connected', timezone: process.env.TZ, timestamp: new Date() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

async function prewarmCache() {
  console.log('[PRE-WARM] Initializing RAM cache in background...');
  try {
    const t0 = Date.now();
    // One fetch fills this month, last month and both months together
    await fetchInflowData(SF_QUEUE_NAME, resolveRange({ range: 'thisMonth' }));
    console.log(`[PRE-WARM] all standard ranges warmed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.warn('[PRE-WARM WARNING]', err.message);
  }
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
// Locally (node server.js / npm start) this is a long-running server: it listens, warms the cache and
// refreshes it every 2 minutes. On Vercel the app is exported instead and each request runs inside a
// serverless function, so there is no listener, timer or pre-warm (the cache fills on the first request).
if (require.main === module && !process.env.VERCEL) {
  // Keep the cache fresh every 2 minutes (one fetch covers every range; never overlaps itself)
  let syncRunning = false;
  setInterval(async () => {
    if (syncRunning) return;
    syncRunning = true;
    try {
      await startFetch(SF_QUEUE_NAME, 'bothMonths');
    } catch (err) {
      console.warn('[SYNC WARNING]', err.message);
    } finally {
      syncRunning = false;
    }
  }, 2 * 60 * 1000);

  app.listen(PORT, HOST, () => {
    console.log(`=========================================`);
    console.log(`Production Server listening on port ${PORT} [TZ: ${process.env.TZ}]`);
    console.log(`=========================================`);
    prewarmCache();
  });
}

module.exports = app;