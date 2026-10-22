// server.js
process.env.TZ = 'Asia/Kolkata'; // Align Node.js to Salesforce Org timezone (IST)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const jsforce = require('jsforce');

const app = express();
const PORT = process.env.PORT || 9001;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const {
  SF_LOGIN_URL = 'https://greyorangeorg.my.salesforce.com',
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_QUEUE_NAME = 'Admin Queue',
} = process.env;

let cachedConn = null;
let cachedQueue = null;
let caseFieldsCache = null;

// Response Cache: 2-Minute TTL (120s) for responsive updates
const responseCache = {
  store: new Map(),
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  },
  set(key, data, ttlSeconds = 120) {
    // Custom ranges create new keys; cap the cache so it cannot grow forever
    if (this.store.size >= 50) this.store.delete(this.store.keys().next().value);
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },
  delete(key) {
    this.store.delete(key);
  },
};

const inFlightRequests = new Map();

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
    };
    return caseFieldsCache;
  } catch (err) {
    return { hasRecordType: false, hasTicketType: false, hasCaseType: false, hasCategory: false };
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

async function poolAll(tasks, limit = 5) {
  const results = [];
  const running = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(task);
    results.push(p);
    if (limit <= tasks.length) {
      const e = p.then(() => running.splice(running.indexOf(e), 1));
      running.push(e);
      if (running.length >= limit) {
        await Promise.race(running);
      }
    }
  }
  return Promise.all(results);
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
  try {
    const conn = await getSalesforceConnection(isRetry);
    const queue = await getQueueMetadata(conn, queueName);
    const schemaFields = await getCaseTypeFields(conn);
    const directQueueMembers = await getQueueMembers(conn, queue.Id);

    const extraCols = [];
    if (schemaFields.hasRecordType) extraCols.push('RecordType.Name');
    if (schemaFields.hasTicketType) extraCols.push('Ticket_Type__c');
    if (schemaFields.hasCaseType) extraCols.push('Case_Type__c');
    if (schemaFields.hasCategory) extraCols.push('Category__c');

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

    const historyQueries = [];
    const scope = scopeForRange(rangeParam);
    const customMatch = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(scope);
    const historySelect = `SELECT CaseId, Field, OldValue, NewValue, CreatedDate FROM CaseHistory WHERE Field = 'Owner'`;

    if (customMatch) {
      const soqlDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const from = parseDay(customMatch[1]);
      const to = new Date(parseDay(customMatch[2]).getTime() + 24 * 60 * 60 * 1000);
      historyQueries.push(
        `${historySelect} AND CreatedDate >= ${soqlDate(from)} AND CreatedDate < ${soqlDate(to)} ORDER BY CreatedDate DESC`
      );
    } else if (scope === 'lastMonth') {
      historyQueries.push(`${historySelect} AND CreatedDate = LAST_MONTH ORDER BY CreatedDate DESC`);
    } else if (scope === 'thisMonth') {
      historyQueries.push(`${historySelect} AND CreatedDate = THIS_MONTH ORDER BY CreatedDate DESC`);
    } else {
      historyQueries.push(
        `${historySelect} AND CreatedDate = THIS_MONTH ORDER BY CreatedDate DESC`,
        `${historySelect} AND CreatedDate = LAST_MONTH ORDER BY CreatedDate DESC`
      );
    }

    const [currentResult, ...historyResults] = await Promise.all([
      conn.query(currentQueueSoql),
      ...historyQueries.map((q) => queryAllHistory(conn, q)),
    ]);

    const historyRecords = historyResults.flat();
    const caseMap = new Map();
    const caseInflowTimestamps = new Map();
    const caseAgentMap = new Map();
    const detectedHistoricalAgents = new Set(directQueueMembers);
    const rawTypesFound = new Set();

    currentResult.records.forEach((c) => {
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
    currentResult.records.forEach((c) => {
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
            CreatedDate: caseInflowTimestamps.get(c.Id) || c.CreatedDate,
          });
        });
      });
    }

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

    // Base records for this scope; rolling/past-week/custom narrowing happens in applyRangeFilter()
    const displayRecords =
      scope === 'thisMonth' ? thisMonthRecords : scope === 'lastMonth' ? lastMonthRecords : unifiedRecords;

    const payload = {
      success: true,
      queueName: queue.Name,
      queueId: queue.Id,
      instanceUrl: conn.instanceUrl,
      range: scope,
      queueAgents: resolvedQueueAgents,
      totalSize: displayRecords.length,
      records: displayRecords,
      weeklyBifurcation: {
        currentMonth: currentMonthBifurcation,
        lastMonth: lastMonthBifurcation,
        allWeeks: [
          ...lastMonthBifurcation.weeks.map((w) => ({ ...w, month: lastMonthBifurcation.month })),
          ...currentMonthBifurcation.weeks.map((w) => ({ ...w, month: currentMonthBifurcation.month })),
        ],
      },
    };

    responseCache.set(`${queueName}_${scope}`, payload, 120);
    return payload;
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

async function fetchInflowData(queueName = SF_QUEUE_NAME, spec = resolveRange({}), forceRefresh = false) {
  const cacheKey = `${queueName}_${spec.scope}`;

  if (!forceRefresh) {
    const cached = responseCache.get(cacheKey);
    if (cached) return applyRangeFilter(cached, spec);
  }

  if (!inFlightRequests.has(cacheKey)) {
    inFlightRequests.set(
      cacheKey,
      executeInflowFetch(queueName, spec.scope).finally(() => inFlightRequests.delete(cacheKey))
    );
  }

  return applyRangeFilter(await inFlightRequests.get(cacheKey), spec);
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
    for (const range of ['thisMonth', 'lastMonth', 'bothMonths']) {
      const t0 = Date.now();
      await fetchInflowData(SF_QUEUE_NAME, resolveRange({ range }));
      console.log(`[PRE-WARM] "${range}" warmed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  } catch (err) {
    console.warn('[PRE-WARM WARNING]', err.message);
  }
}

// Auto-sync every 2 minutes
setInterval(async () => {
  try {
    await Promise.all([
      executeInflowFetch(SF_QUEUE_NAME, 'thisMonth'),
      executeInflowFetch(SF_QUEUE_NAME, 'bothMonths'),
    ]);
  } catch (err) {
    console.warn('[SYNC WARNING]', err.message);
  }
}, 2 * 60 * 1000);

app.listen(PORT, HOST, () => {
  console.log(`=========================================`);
  console.log(`Production Server listening on port ${PORT} [TZ: ${process.env.TZ}]`);
  console.log(`=========================================`);
  prewarmCache();
});