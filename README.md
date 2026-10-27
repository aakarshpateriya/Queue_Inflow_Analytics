# Queue Inflow Analytics

A live dashboard for a Salesforce case queue (by default the **Admin Queue**). It shows how many tickets arrive, when, what type they are, who is handling them, and which open tickets have been waiting too long.

There is no database. The server reads Salesforce, keeps the result in memory for a short time so the page stays fast, and the browser draws it.

## Features

- **Timeframes:** Current Month, Last Calendar Month, Last and Current Months, Rolling 30 Days, Past Week 1 to 4, or a **Custom Range** (up to 365 days).
- **Type tabs:** All Inflow, Incidents, Service Requests, Feature Requests, Other. A tab filters the whole dashboard.
- **KPI cards** (each one clickable, opens the tickets behind the number): Total Inflow, Daily Workday Average, Peak Arrival Day, Aging Cases (> 24h).
- **Charts:** daily ticket intake with a 7-day trendline, case status donut (click a slice to jump to its tickets), hourly arrival curve.
- **Agent workload table:** tickets per person and ticket type, with its own timeframe. The total always matches Total Inflow. Names, counts and totals are clickable.
- **Cases list:** search plus three dropdowns, **Status**, **Type** (the Salesforce Ticket Type list) and **Tool Type**. Case numbers link to Salesforce. CSV export.
- **Drill-down window:** searchable, sortable, filterable by type, exportable.
- Optional password, loading placeholders, and a clear message when data cannot be loaded.

## How it works

```
Browser (public/)  <--->  Server (server.js)  <--->  Salesforce
 page, charts, tables      API + in-memory cache      Case, CaseHistory,
                                                      Group, GroupMember, User
```

1. The page calls `GET /api/queue-inflow`.
2. The server answers from its cache when it can. Otherwise it logs in to Salesforce (OAuth client-credentials flow), reads the queue's tickets, the queue members and two months of owner-change history, and works out when each ticket entered the queue and who took it.
3. One Salesforce fetch fills this month, last month and both months together, so the three views always agree.
4. Cached data is **fresh for 2 minutes** and still served instantly for up to **15 minutes** while a refresh runs in the background.

## Project structure

```
server.js          Express server: API, Salesforce access, caching, optional password
package.json       Dependencies and scripts
public/
  index.html       Page layout
  app.js           All browser logic: filters, KPIs, charts, tables, drill-down
  styles.css       Look and loading placeholders
```

## Requirements

- Node.js 18 or newer (22 recommended)
- A Salesforce **Connected App** with the **Client Credentials** flow enabled and a run-as user
- The run-as user needs read access to Case, CaseHistory, Group, GroupMember, User and UserRole
- Optional: read access to the Case field **Tool Type** (`Tools_Platform__c`). Without it the Tool Type column stays empty and nothing else breaks.

## Quick start

```bash
git clone https://github.com/aakarshpateriya/Queue_Inflow_Analytics.git
cd Queue_Inflow_Analytics
npm install --omit=dev
```

Create a file named `.env` next to `server.js` (never commit it):

```
SF_LOGIN_URL=https://your-domain.my.salesforce.com
SF_CLIENT_ID=your_client_id
SF_CLIENT_SECRET=your_client_secret
SF_QUEUE_NAME=Admin Queue
PORT=3000
DASHBOARD_PASSWORD=choose-a-password
```

Start it and open `http://localhost:3000`:

```bash
npm start                      # or: node --watch server.js  (restarts on changes)
curl -u admin:choose-a-password http://localhost:3000/api/health    # expect "salesforce":"connected"
```

## Configuration

| Setting | Required | Meaning |
|---|---|---|
| `SF_LOGIN_URL` | Yes | Your Salesforce My Domain URL |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | Yes | Connected App credentials |
| `SF_QUEUE_NAME` | No | Queue to watch (default `Admin Queue`) |
| `PORT` | No | Port to listen on (default `9001`). Pick one nothing else uses. |
| `HOST` | No | `0.0.0.0` (default) or `127.0.0.1` to stay behind a reverse proxy |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | Recommended | When a password is set, the data API asks for a login (user defaults to `admin`) |
| `INCLUDE_OTHER_OWNERS` | No | `true` also counts tickets that left the queue for people outside it |
| `HISTORY_SLICE_DAYS` / `HISTORY_CONCURRENCY` | No | Tuning for the history download (defaults 7 and 4) |

## Which tickets count

A ticket counts if it is **in the queue right now**, or **owned by someone who is in the queue**. Membership includes people added directly, through public groups (including nested ones) or roles, active or not.

- Active people added directly to the queue get their own row.
- Other queue members are grouped under **Others (other queue members)**.
- Tickets still owned by the queue show as **Unassigned (still in queue)**.
- Tickets that left the queue for someone outside it are not counted anywhere.

## Definitions

| Item | Meaning |
|---|---|
| Inflow date | When the ticket most recently entered the queue (within the last two months) |
| Daily Workday Average | Weekday (Mon to Fri) tickets divided by the number of weekdays in the window |
| Peak Arrival Day | The calendar day with the most tickets |
| Aging case | A ticket with status New or Assigned that entered the queue more than 24 hours ago (plain hours, not business hours) |
| Ticket Type | The Salesforce Ticket Type: Feature Request, Incident, Service Request, Query, Tool Migration, New Tool Request, Integration/Automation. Other values found on tickets are added to the dropdown automatically. |
| Tabs and agent columns | Group tickets as Incident, Service Request, Feature Request or Other. Tool Migration, New Tool Request, Integration/Automation, Query and anything unrecognised fall under **Other**. |
| Tool Type | Case field `Tools_Platform__c` (automation tickets). Most tickets leave it empty. |

The server works in India Standard Time for month and week boundaries. Times shown in the browser use the viewer's own time zone.

## API

`GET /api/queue-inflow`

| Parameter | Values |
|---|---|
| `range` | `thisMonth` (default), `lastMonth`, `bothMonths`, `rolling30`, `pastWeek1` to `pastWeek4`, `custom` |
| `start`, `end` | `YYYY-MM-DD`, required when `range=custom` (max 365 days) |
| `refresh` | `true` discards the cache and waits for fresh data |

`GET /api/health` checks the Salesforce login.

Errors: `400` invalid custom range, `401` login required, `500` Salesforce or server failure.

## Deploying

### On your own server or VM (recommended)

```bash
git clone https://github.com/aakarshpateriya/Queue_Inflow_Analytics.git dashboard_master
cd dashboard_master && npm install --omit=dev
nano .env                                              # settings from above, with a free PORT
pm2 start server.js --name dashboard-master && pm2 save
```

Open `http://<server-ip>:<PORT>/`. To update:

```bash
cd ~/dashboard_master && git pull && pm2 restart dashboard-master
```

A long-running server warms the cache at start-up and refreshes it every 2 minutes, so pages load almost instantly. The page uses relative URLs, so it also works behind a reverse proxy under a path such as `/dashboard_master/`.

### On Vercel

The app is prepared for Vercel: page files are in `public/`, and `server.js` exports the Express app instead of listening. Import the repo, add the settings above under Environment Variables, and set `DASHBOARD_PASSWORD` (a Vercel address is public unless protected). There are no timers on Vercel, so the first visit after a quiet period waits for a full Salesforce fetch.

## Security

- Keep `.env` out of git. The repo may be public, so never commit secrets. If a secret was ever committed, rotate it.
- Set `DASHBOARD_PASSWORD` for any address others can reach. Ticket subjects can be sensitive.
- Ticket text is HTML-escaped before display, and CSV exports neutralise spreadsheet formulas.
- Use a Salesforce integration user with read-only access to what the dashboard needs.

## Troubleshooting

| Problem | Likely cause |
|---|---|
| `Missing SF_CLIENT_ID or SF_CLIENT_SECRET` | A name is misspelled in `.env` or a line starts with a space |
| `Salesforce OAuth Error` | Wrong login URL, client ID or secret, or the Connected App is not set up for the client-credentials flow with a run-as user |
| `EADDRINUSE` | The port is taken. Change `PORT`. |
| Page loads but stays empty | Open the browser console and the server log. The page also shows the reason next to the timeframe. |
| Tool Type column is empty | The integration user cannot read `Tools_Platform__c` (field-level security) |
| `[SCOPE WARNING]` in the log | Queue groups or roles could not be read, so the owner filter was skipped. Grant read access to groups, roles and users. |
| Times out from another machine but works on the server | A firewall is blocking the port |
| First load takes 20 to 30 seconds | Normal after a restart or on Vercel: a full Salesforce fetch. The server log prints `[FETCH]` with timings. |

## Known limitations

- The Hourly Arrival Curve card says "UTC" but shows the viewer's local hours.
- Refresh reads the server cache (at most a couple of minutes old). Use `/api/queue-inflow?refresh=true` to force a fresh fetch.
- CSV upload uses a simple parser, so subjects containing commas can be misread. JSON upload is reliable.
- The Origin column always shows "Portal" because Origin is not requested from Salesforce.
- The queue name sent to the API is not validated against the configured queue.

## License

ISC
