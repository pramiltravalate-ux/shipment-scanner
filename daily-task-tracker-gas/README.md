# Daily Task Sheet Tracker — Google Apps Script version

A real shared backend for the Daily Task Sheet Tracker, built the same way
`ShipmentManager.gs` (referenced by `../index.html`) is: a Google Sheet holds
the data, Apps Script serves the UI and exposes server functions, and
everyone who opens the deployed Web App URL is reading/writing the same
sheet.

This is a separate, standalone project from `../daily-tasks.html` (which
keeps everything in one browser's `localStorage`, for quick single-device
use). Use this version when you want the tracker shared across your team.

## Files

- `Code.gs` — server: reads/writes a `DailyTasks` sheet tab (auto-created on
  first run) and serves the UI.
- `Index.html` — the front end (same look as `daily-tasks.html`), talking to
  `Code.gs` via `google.script.run` instead of `localStorage`.
- `appsscript.json` — project manifest (timezone, Web App access settings).

## Data model

One row per task in a `DailyTasks` tab:

| ID | Date | Status | SortOrder | Name | Priority | Tags | Labels | Subtasks | CreatedAt | UpdatedAt |
|----|------|--------|-----------|------|----------|------|--------|----------|-----------|-----------|

`Status` is one of `todo` / `progress` / `complete`. `Tags`, `Labels`, and
`Subtasks` are stored as JSON strings. You can open the sheet directly at
any time to inspect, back up, or bulk-edit data.

## Deploy it

1. Create a new Google Sheet (e.g. "Daily Task Sheet Tracker Data").
2. **Extensions → Apps Script**. This opens a script bound to that sheet —
   required, since `Code.gs` uses `SpreadsheetApp.getActiveSpreadsheet()`.
3. Delete the boilerplate `Code.gs` content and paste in this repo's
   `Code.gs`.
4. Add a new HTML file (**+ → HTML**), name it exactly `Index`, and paste in
   this repo's `Index.html`.
5. (Optional) Project Settings → check "Show `appsscript.json` manifest
   file in editor", then replace its contents with this repo's
   `appsscript.json`. Adjust `timeZone` to your own.
6. **Deploy → New deployment → type: Web app.**
   - Execute as: **Me**
   - Who has access: choose based on your needs — see **Access control**
     below before picking this.
7. Copy the generated `.../exec` URL and open it — that's your live
   tracker. Share the same URL with your team; everyone hitting it reads
   and writes the same `DailyTasks` sheet.
8. After changing the code later: **Deploy → Manage deployments → edit
   (pencil) → new version → Deploy**, so the `/exec` URL picks up the
   change (editing the files alone does not update a live deployment).

## Access control

This app has **no login screen or per-user permission model of its own** —
anyone who can open the deployed URL can read and edit every task on every
day's sheet. Access is enforced entirely by the Web App's "Who has access"
setting:

- **Anyone with a Google account** — recommended default. Requires the
  visitor to be signed into a Google account, but does not restrict which
  account (fine for the team's Web App URL if it isn't broadly shared).
- **Anyone** — no sign-in required at all; only use this if the tracker's
  contents are not sensitive and you're fine with it being effectively
  public to anyone who has the link.

If you need real per-user restriction (e.g. only `@yourcompany.com`
accounts, or a Google Workspace domain), that requires a Google Workspace
account, set via the same "Who has access" dropdown at deploy time.

## Known limitations

- **No live push updates.** If a teammate edits the sheet from another tab,
  you won't see it until you reload or switch days — there's no
  realtime sync (Shipment Manager's scanner has the same characteristic).
- **Concurrent edits use a script lock** (`LockService`) so two people
  saving at the exact same moment won't corrupt a row, but the second
  writer's request will simply wait up to 10 seconds for the first to
  finish rather than merging changes.
