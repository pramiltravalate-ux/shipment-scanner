/**
 * Employee Attendance & Salary App — Google Apps Script
 *
 * 1. Create a Google Sheet → Extensions → Apps Script.
 * 2. Paste this file as Code.gs and Index.html as an HTML file named "Index".
 * 3. Run setup() once (authorise when asked), fill the Settings + Employees tabs.
 * 4. Deploy → New deployment → Web app
 *      Execute as: Me      Who has access: Anyone
 *    Share the web app URL with employees.
 */

const SHEET = {
  SETTINGS: 'Settings',
  EMPLOYEES: 'Employees',
  ATTENDANCE: 'Attendance',
  HOLIDAYS: 'Holidays',
  PERMISSIONS: 'Admin Permissions',
  AUDIT: 'Audit Log',
};

const ROLES = ['EMPLOYEE', 'ADMIN', 'SUPER_ADMIN'];

/** What a super admin can allow each admin to do. */
const PERMISSIONS = [
  { key: 'viewToday', label: 'View Today', help: "Today's live attendance and selfies" },
  { key: 'viewPayroll', label: 'View Payroll', help: 'Monthly salary, OT, PF of employees' },
  { key: 'editAttendance', label: 'Edit Attendance', help: 'Add / change / delete entries, including back-dated ones' },
  { key: 'editPf', label: 'Edit PF', help: 'Turn PF on/off and change PF amounts' },
  { key: 'exportPayroll', label: 'Export Payroll', help: 'Create the payroll tab in the Sheet' },
  { key: 'editOwn', label: 'Edit Own Entries', help: 'Change their own attendance / PF (normally off)' },
];
const PERM_HEADERS = ['Emp ID', 'Name'].concat(PERMISSIONS.map(p => p.label))
  .concat(['Allowed Employees', 'Updated By', 'Updated At']);
const AUDIT_HEADERS = ['Time', 'By', 'Action', 'Emp ID', 'Date', 'Details'];

const EMP_HEADERS = ['Emp ID', 'Name', 'PIN', 'Monthly Salary', 'Role', 'Active', 'Join Date', 'Phone',
  'PF Active', 'PF Bank Salary', 'PF Employee', 'PF Employer'];

const ATT_HEADERS = ['Date', 'Emp ID', 'Name', 'Check In', 'Check Out', 'Worked Hrs', 'Status', 'Late',
  'OT Hrs', 'In Lat', 'In Lng', 'In Distance (m)', 'In Accuracy (m)', 'Out Lat', 'Out Lng',
  'Out Distance (m)', 'Selfie', 'Override Status', 'Admin Note'];

const COL = {
  DATE: 0, EMP: 1, NAME: 2, IN: 3, OUT: 4, WORKED: 5, STATUS: 6, LATE: 7, OT: 8,
  IN_LAT: 9, IN_LNG: 10, IN_DIST: 11, IN_ACC: 12, OUT_LAT: 13, OUT_LNG: 14, OUT_DIST: 15,
  SELFIE: 16, OVERRIDE: 17, NOTE: 18,
};

const OVERRIDE_VALUES = ['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE'];

const DEFAULT_SETTINGS = [
  ['Company Name', 'My Company', 'Shown at the top of the app'],
  ['Office Latitude', '', 'Google Maps → right-click your office → click the coordinates to copy them'],
  ['Office Longitude', '', 'Paste the second number here'],
  ['Allowed Radius (m)', 30, 'Employee must be within this distance of the office'],
  ['Max GPS Accuracy (m)', 50, 'Readings less accurate than this are rejected (higher = more lenient)'],
  ['Check Location On Check-Out', 'Yes', 'Yes / No'],
  ['Selfie Required', 'Yes', 'Yes / No (selfie is taken at check-in)'],
  ['Shift Start', '09:30', '24-hour time, HH:mm'],
  ['Late Grace (min)', 10, 'Check-in after Shift Start + grace = Late'],
  ['Standard Hours', 9, 'Hours per day. Time worked beyond this is OT'],
  ['Full Day Min Hours', 8, 'Worked hours needed for a full day'],
  ['Half Day Min Hours', 4, 'At least this (but below Full Day) = Half Day. Less = Absent'],
  ['No Check-Out Counts As', 'HALF_DAY', 'PRESENT / HALF_DAY / ABSENT — when an employee forgets to check out'],
  ['Salary Days Basis', 30, 'Per day = Monthly Salary ÷ this. Per hour = per day ÷ Standard Hours. (0 = days in that month)'],
  ['OT Multiplier', 1.5,'OT pay = net OT minutes × per-minute rate × this'],
  ['OT Block (min)', 0, 'Daily OT counted only in complete blocks of this many minutes (0 = every minute)'],
  ['Late Minutes Reduce OT', 'Yes', 'Monthly OT minutes − total late minutes (minutes after Shift Start on late days)'],
  ['Weekly Off', 'Sunday', 'Comma separated, e.g. Sunday  or  Saturday,Sunday'],
  ['Off-Day Work Is OT', 'Yes', 'All hours worked on a weekly off / holiday count as OT'],
  ['Lates Per Half-Day Cut', 0, 'Every N late marks in a month deduct half a day (0 = no deduction)'],
  ['Phone Time Tolerance (min)', 3, 'Check-in is blocked if the phone clock differs from real time by more than this'],
  ['Default PF Bank Salary %', 90, 'Used when an employee\'s "PF Bank Salary" is blank (e.g. 90% of 15000 = 13500)'],
  ['Default PF Employee %', 12, 'Used when "PF Employee" is blank — % of PF Bank Salary'],
  ['Default PF Employer %', 13, 'Used when "PF Employer" is blank — % of PF Bank Salary'],
  ['OT & Deductions Paid In', 'CASH', 'CASH / BANK — for PF employees, which part absorbs OT and leave/half-day deductions'],
  ['Admin Back-Date Limit (days)', 45, 'Admins can add/change entries up to this many days back (super admin: no limit; 0 = no limit)'],
  ['Currency', '₹', ''],
  ['Selfie Folder ID', '', 'Filled automatically'],
];

/* ------------------------------------------------------------------ */
/* Web app entry + sheet menu                                          */
/* ------------------------------------------------------------------ */

function doGet() {
  const t = HtmlService.createTemplateFromFile('Index');
  t.company = getSettings_().company;
  return t.evaluate()
    .setTitle(t.company + ' – Attendance')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Attendance App')
    .addItem('Run setup / repair sheets', 'setup')
    .addToUi();
}

/** Creates the tabs, headers, formats and defaults. Safe to run again. */
function setup() {
  const ss = SpreadsheetApp.getActive();

  // Settings
  let sh = getOrCreate_(ss, SHEET.SETTINGS, ['Setting', 'Value', 'Notes']);
  sh.getRange('B:B').setNumberFormat('@');
  const existing = sh.getDataRange().getValues().map(r => String(r[0]).trim());
  DEFAULT_SETTINGS.forEach(row => {
    if (existing.indexOf(row[0]) < 0) sh.appendRow([row[0], String(row[1]), row[2]]);
  });
  sh.setColumnWidth(1, 220).setColumnWidth(2, 160).setColumnWidth(3, 520);

  // Employees
  sh = getOrCreate_(ss, SHEET.EMPLOYEES, EMP_HEADERS);
  ensureHeaders_(sh, EMP_HEADERS);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('C:C').setNumberFormat('@');
  sh.getRange('E2:E').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(ROLES, true).build());
  const yesNo = SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).build();
  sh.getRange('F2:F').setDataValidation(yesNo);
  const pfCol = headerIndex_(sh)['PF Active'] + 1;
  sh.getRange(2, pfCol, sh.getMaxRows() - 1, 1).setDataValidation(yesNo);
  if (sh.getLastRow() < 2) {
    sh.appendRow(['E001', 'Owner', '1234', 30000, 'SUPER_ADMIN', 'Yes', todayStr_(), '', 'No', '', '', '']);
    sh.appendRow(['E002', 'Sample Employee', '1111', 15000, 'EMPLOYEE', 'Yes', todayStr_(), '', 'Yes', 13500, 1721, 1755]);
  }

  // Attendance
  sh = getOrCreate_(ss, SHEET.ATTENDANCE, ATT_HEADERS);
  ['A:A', 'D:D', 'E:E'].forEach(a => sh.getRange(a).setNumberFormat('@'));
  sh.getRange(2, COL.OVERRIDE + 1, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(OVERRIDE_VALUES, true)
      .setAllowInvalid(false).build());

  // Holidays
  sh = getOrCreate_(ss, SHEET.HOLIDAYS, ['Date', 'Holiday Name']);
  sh.getRange('A:A').setNumberFormat('@');

  // Admin permissions + audit log
  sh = getOrCreate_(ss, SHEET.PERMISSIONS, PERM_HEADERS);
  ensureHeaders_(sh, PERM_HEADERS);
  sh.getRange('A:A').setNumberFormat('@');
  getOrCreate_(ss, SHEET.AUDIT, AUDIT_HEADERS);

  delete getSettings_.cache;
  getSelfieFolder_(getSettings_());

  try {
    SpreadsheetApp.getUi().alert('Setup complete.\n\n1. Fill Office Latitude / Longitude in Settings.\n' +
      '2. Add employees (Emp ID, Name, PIN, Salary).\n3. Deploy → New deployment → Web app.');
  } catch (e) { /* run from editor without UI */ }
}

/* ------------------------------------------------------------------ */
/* Public API — called from the web page via google.script.run         */
/* ------------------------------------------------------------------ */

function login(empId, pin) {
  empId = String(empId || '').trim().toUpperCase();
  pin = String(pin || '').trim();
  if (!empId || !pin) throw new Error('Enter Employee ID and PIN.');

  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + empId;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new Error('Too many wrong attempts. Try again after 15 minutes.');

  const emp = findEmployee_(empId);
  if (!emp || !emp.active || emp.pin !== pin) {
    cache.put(failKey, String(fails + 1), 900);
    throw new Error('Invalid Employee ID or PIN.');
  }
  cache.remove(failKey);
  const token = Utilities.getUuid();
  cache.put('tok_' + token, emp.id, 21600); // 6 hours (CacheService maximum)
  return { token: token, profile: profile_(emp) };
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('tok_' + token);
  return true;
}

function getHome(token) {
  const emp = auth_(token);
  const s = getSettings_();
  const today = todayStr_();
  const rec = readAttendance_().filter(r => r.empId === emp.id && r.date === today)[0];
  const offType = offType_(today, s, getHolidays_());
  const day = rec ? evaluateDay_(rec, s, offType, true) : { status: offType || 'NOT_MARKED' };
  return {
    profile: profile_(emp),
    company: s.company,
    today: today,
    todayLabel: Utilities.formatDate(new Date(), tz_(), 'EEEE, dd MMM yyyy'),
    offType: offType,
    record: rec ? { in: rec.in, out: rec.out } : null,
    day: day,
    office: {
      lat: isFinite(s.officeLat) ? s.officeLat : null, lng: isFinite(s.officeLng) ? s.officeLng : null,
      radius: s.radius, maxAccuracy: s.maxAccuracy,
    },
    selfieRequired: s.selfieRequired,
    checkoutLocation: s.checkoutLocation,
    shiftStart: minutesToStr_(s.shiftStartMin),
    standardHours: s.standardHours,
    server: serverClock_(),
    clockTolerance: s.clockTolerance,
  };
}

function checkIn(token, lat, lng, accuracy, selfieDataUrl, phoneClock) {
  const emp = auth_(token);
  const s = getSettings_();
  checkPhoneClock_(s, phoneClock);
  const loc = checkLocation_(s, lat, lng, accuracy);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const today = todayStr_();
    const now = Utilities.formatDate(new Date(), tz_(), 'HH:mm');
    const already = readAttendance_().some(r => r.empId === emp.id && r.date === today && r.in);
    if (already) throw new Error('You have already checked in today.');

    let selfieUrl = '';
    if (s.selfieRequired || selfieDataUrl) {
      selfieUrl = saveSelfie_(selfieDataUrl, today + '_' + emp.id + '_' + now.replace(':', '') + '.jpg', s);
    }
    const offType = offType_(today, s, getHolidays_());
    const late = !offType && toMinutes_(now) > s.shiftStartMin + s.lateGrace;

    const row = new Array(ATT_HEADERS.length).fill('');
    row[COL.DATE] = "'" + today;
    row[COL.EMP] = emp.id;
    row[COL.NAME] = emp.name;
    row[COL.IN] = "'" + now;
    row[COL.STATUS] = 'WORKING';
    row[COL.LATE] = late ? 'Yes' : '';
    row[COL.IN_LAT] = loc.lat;
    row[COL.IN_LNG] = loc.lng;
    row[COL.IN_DIST] = loc.dist;
    row[COL.IN_ACC] = loc.acc;
    row[COL.SELFIE] = selfieUrl;
    const sh = sheet_(SHEET.ATTENDANCE);
    sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();
    return { time: now, late: late, distance: loc.dist };
  } finally {
    lock.releaseLock();
  }
}

function checkOut(token, lat, lng, accuracy, phoneClock) {
  const emp = auth_(token);
  const s = getSettings_();
  checkPhoneClock_(s, phoneClock);
  const loc = s.checkoutLocation ? checkLocation_(s, lat, lng, accuracy) : null;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const today = todayStr_();
    const rec = readAttendance_().filter(r => r.empId === emp.id && r.date === today && r.in)[0];
    if (!rec) throw new Error('You have not checked in today.');
    if (rec.out) throw new Error('You have already checked out today (at ' + rec.out + ').');

    const now = Utilities.formatDate(new Date(), tz_(), 'HH:mm');
    rec.out = now;
    const d = evaluateDay_(rec, s, offType_(today, s, getHolidays_()), false);

    const sh = sheet_(SHEET.ATTENDANCE);
    sh.getRange(rec.row, COL.OUT + 1, 1, 5).setValues([["'" + now, d.worked, d.status, d.late ? 'Yes' : '', d.ot]]);
    if (loc) sh.getRange(rec.row, COL.OUT_LAT + 1, 1, 3).setValues([[loc.lat, loc.lng, loc.dist]]);
    SpreadsheetApp.flush();
    return { time: now, worked: d.worked, ot: d.ot, status: d.status };
  } finally {
    lock.releaseLock();
  }
}

/** Monthly attendance, OT and salary for the logged-in employee. ym = 'yyyy-MM'. */
function getMyMonth(token, ym) {
  const emp = auth_(token);
  return buildMonth_(emp, validYm_(ym));
}

/* ---------------------------- Admin ------------------------------- */
/*
 * Every admin call checks a permission (see PERMISSIONS) and the list of employees the admin may
 * manage. SUPER_ADMIN has every permission for every employee and sets the permissions of ADMINs
 * from the app (Admin → Admins). They are stored in the "Admin Permissions" tab.
 */

function adminToday(token) {
  const ctx = authAdmin_(token, 'viewToday');
  const s = getSettings_();
  const today = todayStr_();
  const offType = offType_(today, s, getHolidays_());
  const recs = {};
  readAttendance_().forEach(r => { if (r.date === today && !recs[r.empId]) recs[r.empId] = r; });

  const counts = { total: 0, in: 0, late: 0, out: 0, notMarked: 0 };
  const list = getEmployees_().filter(e => e.active && canManage_(ctx, e.id)).map(e => {
    const r = recs[e.id];
    const d = r ? evaluateDay_(r, s, offType, true) : { status: offType || 'NOT_MARKED' };
    counts.total++;
    if (r && r.in) counts.in++;
    if (d.late) counts.late++;
    if (r && r.out) counts.out++;
    if (!r || !r.in) counts.notMarked++;
    return {
      id: e.id, name: e.name, in: r ? r.in : '', out: r ? r.out : '', status: d.status,
      late: !!d.late, worked: d.worked || 0, distance: r ? r.inDist : '', row: r ? r.row : 0,
      hasSelfie: !!(r && r.selfie),
    };
  });
  list.sort((a, b) => (a.in ? 0 : 1) - (b.in ? 0 : 1) || a.name.localeCompare(b.name));
  return { date: today, offType: offType, counts: counts, list: list };
}

function adminMonth(token, ym) {
  const ctx = authAdmin_(token, 'viewPayroll');
  return payrollRows_(ctx, validYm_(ym));
}

function payrollRows_(ctx, ym) {
  const s = getSettings_();
  const holidays = getHolidays_();
  const att = readAttendance_().filter(r => r.date.indexOf(ym) === 0);
  const withRecords = {};
  att.forEach(r => { withRecords[r.empId] = true; });

  const rows = getEmployees_().filter(e => (e.active || withRecords[e.id]) && canManage_(ctx, e.id)).map(e => {
    const m = monthSummary_(e, ym, s, byDate_(att, e.id), holidays);
    return Object.assign({ id: e.id, name: e.name }, m.totals, m.pay);
  });
  return { ym: ym, label: ymLabel_(ym), currency: s.currency, rows: rows };
}

/** One employee's calendar. Salary is hidden unless the admin has "View Payroll". */
function adminEmployeeMonth(token, empId, ym) {
  const ctx = authAdmin_(token, ['viewPayroll', 'editAttendance']);
  const emp = managedEmployee_(ctx, empId);
  const m = buildMonth_(emp, validYm_(ym));
  if (!ctx.perms.viewPayroll) delete m.pay;
  m.canEdit = canEditEmployee_(ctx, emp.id);
  m.minDate = ctx.minDate;
  return m;
}

/** Employees this admin may pick in the "Entries" screen, plus the allowed date range. */
function adminEntryOptions(token) {
  const ctx = authAdmin_(token, 'editAttendance');
  return {
    employees: getEmployees_().filter(e => e.active && canEditEmployee_(ctx, e.id))
      .map(e => ({ id: e.id, name: e.name })),
    minDate: ctx.minDate,
    maxDate: todayStr_(),
    overrides: OVERRIDE_VALUES,
  };
}

/** The attendance entry (if any) for one employee on one date. */
function adminGetEntry(token, empId, date) {
  const ctx = authAdmin_(token, 'editAttendance');
  const emp = managedEmployee_(ctx, empId, true);
  date = checkEntryDate_(ctx, date);
  const s = getSettings_();
  const off = offType_(date, s, getHolidays_());
  const rec = readAttendance_().filter(r => r.empId === emp.id && r.date === date)[0];
  return {
    empId: emp.id, name: emp.name, date: date, offType: off,
    exists: !!rec,
    in: rec ? rec.in : '', out: rec ? rec.out : '', override: rec ? rec.override : '',
    note: rec ? String(rec.note || '') : '', hasSelfie: !!(rec && rec.selfie),
    day: rec ? evaluateDay_(rec, s, off, date === todayStr_()) : null,
  };
}

/**
 * Adds or updates a (back-dated) entry.
 * entry = { empId, date: 'yyyy-MM-dd', in: 'HH:mm', out: 'HH:mm', override: '' | PRESENT | HALF_DAY | ABSENT | LEAVE, note }
 */
function adminSaveEntry(token, entry) {
  const ctx = authAdmin_(token, 'editAttendance');
  const emp = managedEmployee_(ctx, entry && entry.empId, true);
  const date = checkEntryDate_(ctx, entry.date);
  const e = cleanEntry_(entry);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ctxData = entryContext_();
    const result = upsertEntry_(ctxData, emp, date, e, ctx.emp, true);
    flushNewRows_(ctxData);
    audit_(ctx.emp, result.created ? 'ADD_ENTRY' : 'EDIT_ENTRY', emp.id, date, result.before + ' → ' + entryText_(e));
    return adminGetEntry(token, emp.id, date);
  } finally {
    lock.releaseLock();
  }
}

function adminDeleteEntry(token, empId, date) {
  const ctx = authAdmin_(token, 'editAttendance');
  const emp = managedEmployee_(ctx, empId, true);
  date = checkEntryDate_(ctx, date);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const rec = readAttendance_().filter(r => r.empId === emp.id && r.date === date)[0];
    if (!rec) throw new Error('No entry for this date.');
    sheet_(SHEET.ATTENDANCE).deleteRow(rec.row);
    audit_(ctx.emp, 'DELETE_ENTRY', emp.id, date, entryText_(rec));
    return true;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Fills many days at once (e.g. the days before the app went live).
 * opts = { empIds: [...] , from, to, in, out, override, note, skipOff: true, overwrite: false }
 */
function adminBulkEntry(token, opts) {
  const ctx = authAdmin_(token, 'editAttendance');
  opts = opts || {};
  const from = checkEntryDate_(ctx, opts.from);
  const to = checkEntryDate_(ctx, opts.to);
  if (to < from) throw new Error('"To" date must be on or after "From" date.');
  const ids = (opts.empIds || []).map(x => String(x).toUpperCase()).filter((x, i, arr) => arr.indexOf(x) === i);
  if (!ids.length) throw new Error('Select at least one employee.');
  const emps = ids.map(id => managedEmployee_(ctx, id, true));
  const e = cleanEntry_(opts);
  const s = getSettings_();
  const holidays = getHolidays_();

  const dates = [];
  for (let d = from; d <= to; d = addDays_(d, 1)) {
    if (opts.skipOff !== false && offType_(d, s, holidays)) continue;
    dates.push(d);
    if (dates.length > 62) throw new Error('Please fill at most 62 days at a time.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let added = 0, updated = 0, skipped = 0;
    const data = entryContext_();
    emps.forEach(emp => dates.forEach(date => {
      if (emp.joinDate && date < emp.joinDate) { skipped++; return; }
      const r = upsertEntry_(data, emp, date, e, ctx.emp, !!opts.overwrite);
      if (r.skipped) skipped++; else if (r.created) added++; else updated++;
    }));
    flushNewRows_(data);
    audit_(ctx.emp, 'BULK_ENTRY', ids.join(','), from + ' to ' + to,
      entryText_(e) + ' | added ' + added + ', updated ' + updated + ', skipped ' + skipped);
    return { added: added, updated: updated, skipped: skipped, days: dates.length };
  } finally {
    lock.releaseLock();
  }
}

/** Employee list with PF settings for the admin "PF Setup" screen. */
function adminEmployees(token) {
  const ctx = authAdmin_(token, 'editPf');
  const s = getSettings_();
  return {
    currency: s.currency,
    defaults: { bank: s.pfBankPct, employee: s.pfEmployeePct, employer: s.pfEmployerPct },
    list: getEmployees_().filter(e => e.active && canEditEmployee_(ctx, e.id)).map(e => {
      const pf = pfAmounts_(e, s);
      return {
        id: e.id, name: e.name, salary: e.salary, pfActive: e.pf.active,
        bankSalaryRaw: String(e.pf.bankSalary), employeeRaw: String(e.pf.employee), employerRaw: String(e.pf.employer),
        bankSalary: round2_(pf.bankSalary), employee: round2_(pf.employee), employer: round2_(pf.employer),
      };
    }),
  };
}

/** Turns PF on/off and sets the amounts for one employee. Blank = use % defaults from Settings. */
function adminSavePf(token, empId, data) {
  const ctx = authAdmin_(token, 'editPf');
  const emp = managedEmployee_(ctx, empId, true);
  const clean = v => {
    const str = String(v === undefined || v === null ? '' : v).trim();
    if (!str) return '';
    if (/^\d+(\.\d+)?%$/.test(str)) return str;
    if (isNaN(Number(str)) || Number(str) < 0) throw new Error('Invalid amount: ' + str);
    return Number(str);
  };
  const vals = [data && data.active ? 'Yes' : 'No', clean(data && data.bankSalary),
    clean(data && data.employee), clean(data && data.employer)];
  const sh = sheet_(SHEET.EMPLOYEES);
  ensureHeaders_(sh, EMP_HEADERS);
  const h = headerIndex_(sh);
  ['PF Active', 'PF Bank Salary', 'PF Employee', 'PF Employer'].forEach((name, i) => {
    sh.getRange(emp.row, h[name] + 1).setValue(vals[i]);
  });
  SpreadsheetApp.flush();
  audit_(ctx.emp, 'EDIT_PF', emp.id, '', 'PF ' + vals[0] + ', bank ' + vals[1] + ', employee ' + vals[2] +
    ', employer ' + vals[3]);
  return adminEmployees(token);
}

/** Returns the check-in selfie as a data URL so admins can view it inside the app. */
function adminGetSelfie(token, row) {
  const ctx = authAdmin_(token, ['viewToday', 'editAttendance']);
  const vals = sheet_(SHEET.ATTENDANCE).getRange(Number(row), 1, 1, ATT_HEADERS.length).getValues()[0];
  if (!canManage_(ctx, String(vals[COL.EMP]).trim().toUpperCase())) throw new Error('Not allowed.');
  const url = String(vals[COL.SELFIE]);
  const m = /\/d\/([\w-]+)/.exec(url) || /id=([\w-]+)/.exec(url);
  if (!m) throw new Error('No selfie for this entry.');
  const blob = DriveApp.getFileById(m[1]).getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/** Writes a "Payroll yyyy-MM" tab with every employee's salary for the month. */
function adminExportPayroll(token, ym) {
  const ctx = authAdmin_(token, 'exportPayroll');
  const data = payrollRows_(ctx, validYm_(ym));
  const ss = SpreadsheetApp.getActive();
  const name = 'Payroll ' + data.ym;
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  const header = ['Emp ID', 'Name', 'Total Salary', 'Present', 'Half Days', 'Absent (Leaves)', 'Paid Leave',
    'Week Off', 'Holidays', 'Worked on Off-Day', 'Late Marks', 'Late Mins', 'OT Mins (gross)', 'OT Mins (net)',
    'OT Hrs (net)', 'Per Day', 'Per Hour', 'Per Min', 'OT Pay', 'Leave Deduction', 'Half Day Deduction',
    'Late Cut Deduction', 'Gross Payable', 'PF', 'PF Bank Salary', 'PF Employee', 'PF Employer', 'In Bank',
    'In Cash', 'Net Salary'];
  const rows = data.rows.map(r => [r.id, r.name, r.salary, r.present, r.halfDay, r.absent + r.notJoined, r.leave,
    r.weekOff, r.holiday, r.offWork, r.late, r.lateMin, r.otMinGross, r.otMin, r.otHours, r.perDay, r.hourly,
    r.perMin, r.otPay, r.leaveDed, r.halfDayDed, r.lateCutDed, r.gross, r.pf ? 'Yes' : 'No',
    r.pf ? r.pfBankSalary : '', r.pf ? r.pfEmployee : '', r.pf ? r.pfEmployer : '', r.pf ? r.bank : '',
    r.pf ? r.cash : '', r.net]);
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eefc');
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, header.length);
  audit_(ctx.emp, 'EXPORT_PAYROLL', '', data.ym, rows.length + ' employees');
  return { url: ss.getUrl() + '#gid=' + sh.getSheetId(), sheet: name };
}

/* ------------------------- Super admin ----------------------------- */

/** All employees with their role and, for admins, their permissions. */
function superListAdmins(token) {
  authAdmin_(token, 'superAdmin');
  const saved = readPermissions_();
  const emps = getEmployees_().filter(e => e.active);
  return {
    permissions: PERMISSIONS,
    employees: emps.map(e => ({ id: e.id, name: e.name, role: e.role })),
    admins: emps.filter(e => e.role === 'ADMIN').map(e => ({
      id: e.id, name: e.name, perms: permsFor_(e, saved), configured: !!saved[e.id],
    })),
  };
}

/** perms = { viewToday: true, ..., employees: 'ALL' | ['E002', ...] } */
function superSavePermissions(token, empId, perms) {
  const ctx = authAdmin_(token, 'superAdmin');
  const emp = findEmployee_(String(empId).toUpperCase());
  if (!emp || emp.role !== 'ADMIN') throw new Error('This employee is not an admin.');
  perms = perms || {};
  const list = perms.employees === 'ALL' ? 'ALL'
    : (perms.employees || []).map(x => String(x).trim().toUpperCase()).filter(String).join(',');
  const row = [emp.id, emp.name].concat(PERMISSIONS.map(p => (perms[p.key] ? 'Yes' : 'No')))
    .concat([list || 'NONE', ctx.emp.id, Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm')]);

  const sh = permSheet_();
  const ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim().toUpperCase()) : [];
  const i = ids.indexOf(emp.id);
  const at = i >= 0 ? i + 2 : sh.getLastRow() + 1;
  sh.getRange(at, 1, 1, row.length).setValues([row]);
  audit_(ctx.emp, 'SET_PERMISSIONS', emp.id, '', row.slice(2, 2 + PERMISSIONS.length + 1).join(' '));
  return superListAdmins(token);
}

/** Makes an employee an ADMIN or turns an admin back into an EMPLOYEE. */
function superSetRole(token, empId, role) {
  const ctx = authAdmin_(token, 'superAdmin');
  role = String(role).toUpperCase();
  if (['ADMIN', 'EMPLOYEE'].indexOf(role) < 0) throw new Error('Invalid role.');
  const emp = findEmployee_(String(empId).toUpperCase());
  if (!emp) throw new Error('Employee not found.');
  if (emp.role === 'SUPER_ADMIN') throw new Error('Super admins can only be changed in the Employees sheet.');
  sheet_(SHEET.EMPLOYEES).getRange(emp.row, 5).setValue(role);
  audit_(ctx.emp, 'SET_ROLE', emp.id, '', emp.role + ' → ' + role);
  return superListAdmins(token);
}

/** Last 100 audit-log lines (newest first). */
function superAuditLog(token) {
  authAdmin_(token, 'superAdmin');
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.AUDIT);
  if (!sh || sh.getLastRow() < 2) return [];
  const n = Math.min(100, sh.getLastRow() - 1);
  return sh.getRange(sh.getLastRow() - n + 1, 1, n, AUDIT_HEADERS.length).getDisplayValues().reverse()
    .map(r => ({ at: r[0], by: r[1], action: r[2], emp: r[3], date: r[4], details: r[5] }));
}

/* ----------------------- Permission helpers ------------------------ */

function authAdmin_(token, need) {
  const emp = auth_(token);
  const perms = permsFor_(emp);
  const needs = [].concat(need);
  if (!needs.some(k => perms[k])) {
    throw new Error(emp.role === 'EMPLOYEE' ? 'Admin access only.' : 'You do not have permission for this. Ask the super admin.');
  }
  const s = getSettings_();
  return {
    emp: emp,
    perms: perms,
    minDate: perms.superAdmin || !(s.backDateDays > 0) ? '2000-01-01' : addDays_(todayStr_(), -s.backDateDays),
  };
}

/** Effective permissions of an employee. */
function permsFor_(emp, saved) {
  const none = { superAdmin: false, employees: [] };
  PERMISSIONS.forEach(p => { none[p.key] = false; });
  if (emp.role === 'SUPER_ADMIN') {
    const all = { superAdmin: true, employees: 'ALL' };
    PERMISSIONS.forEach(p => { all[p.key] = true; });
    return all;
  }
  if (emp.role !== 'ADMIN') return none;

  saved = saved || readPermissions_();
  const row = saved[emp.id];
  if (!row) {
    // No super admin set up yet → admins keep full access (as before this feature).
    if (!getEmployees_().some(e => e.role === 'SUPER_ADMIN' && e.active)) {
      const legacy = { superAdmin: false, employees: 'ALL' };
      PERMISSIONS.forEach(p => { legacy[p.key] = p.key !== 'editOwn'; });
      return legacy;
    }
    return Object.assign(none, { viewToday: true, employees: 'ALL' }); // safe default
  }
  return row;
}

function readPermissions_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.PERMISSIONS);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  const values = sh.getDataRange().getValues();
  const h = headerIndex_(sh, values[0]);
  values.slice(1).forEach(r => {
    const id = String(r[0]).trim().toUpperCase();
    if (!id) return;
    const p = { superAdmin: false };
    PERMISSIONS.forEach(x => { p[x.key] = /^(y|yes|true|1)$/i.test(String(r[h[x.label]]).trim()); });
    const list = String(r[h['Allowed Employees']] || '').trim().toUpperCase();
    p.employees = list === 'ALL' ? 'ALL' : list.split(/[,\s]+/).filter(x => x && x !== 'NONE');
    map[id] = p;
  });
  return map;
}

function permSheet_() {
  const ss = SpreadsheetApp.getActive();
  return getOrCreate_(ss, SHEET.PERMISSIONS, PERM_HEADERS);
}

/** May this admin see / work with this employee at all? */
function canManage_(ctx, empId) {
  if (ctx.perms.superAdmin) return true;
  if (empId === ctx.emp.id) return true; // everyone can see their own data
  const list = ctx.perms.employees;
  return list === 'ALL' || (list || []).indexOf(empId) >= 0;
}

/** May this admin change data of this employee? Own entries need the "Edit Own Entries" permission. */
function canEditEmployee_(ctx, empId) {
  if (ctx.perms.superAdmin) return true;
  if (empId === ctx.emp.id) return !!ctx.perms.editOwn;
  return canManage_(ctx, empId);
}

function managedEmployee_(ctx, empId, forEdit) {
  const emp = findEmployee_(String(empId || '').trim().toUpperCase());
  if (!emp) throw new Error('Employee not found.');
  const ok = forEdit ? canEditEmployee_(ctx, emp.id) : canManage_(ctx, emp.id);
  if (!ok) throw new Error('You are not allowed to ' + (forEdit ? 'change' : 'view') + ' ' + emp.name + '.');
  return emp;
}

function checkEntryDate_(ctx, date) {
  const d = toDateStr_(date);
  if (!d) throw new Error('Choose a valid date.');
  if (d > todayStr_()) throw new Error('Entries cannot be added for future dates.');
  if (d < ctx.minDate) throw new Error('You can only change entries from ' + ctx.minDate + ' onwards.');
  return d;
}

function cleanEntry_(e) {
  const out = {
    in: toTimeStr_(e.in), out: toTimeStr_(e.out),
    override: OVERRIDE_VALUES.indexOf(String(e.override || '').toUpperCase()) >= 0 ? String(e.override).toUpperCase() : '',
    note: String(e.note || '').trim().slice(0, 300),
  };
  if (out.out && !out.in) throw new Error('Enter the check-in time as well.');
  if (out.in && out.out && toMinutes_(out.out) <= toMinutes_(out.in)) throw new Error('Check-out must be after check-in.');
  if (!out.in && !out.override) throw new Error('Enter a check-in time or choose a status (Present / Half Day / Absent / Leave).');
  return out;
}

/** Reads attendance once so many entries can be written quickly. */
function entryContext_() {
  const map = {};
  readAttendance_().forEach(r => { if (!map[r.empId + '|' + r.date]) map[r.empId + '|' + r.date] = r; });
  return { map: map, newRows: [], s: getSettings_(), holidays: getHolidays_(), sh: sheet_(SHEET.ATTENDANCE) };
}

function flushNewRows_(data) {
  if (!data.newRows.length) return;
  data.sh.getRange(data.sh.getLastRow() + 1, 1, data.newRows.length, ATT_HEADERS.length).setValues(data.newRows);
  data.newRows = [];
  SpreadsheetApp.flush();
}

/** Creates or updates the row for emp + date. Location/selfie of an existing row are kept. */
function upsertEntry_(data, emp, date, e, byEmp, overwrite) {
  const rec = data.map[emp.id + '|' + date];
  if (rec && !overwrite) return { skipped: true };

  const calc = evaluateDay_({ in: e.in, out: e.out, override: e.override }, data.s,
    offType_(date, data.s, data.holidays), date === todayStr_());
  const note = e.note || ('Entered by ' + byEmp.name);
  const status = [e.in ? "'" + e.in : '', e.out ? "'" + e.out : '', calc.worked, calc.status, calc.late ? 'Yes' : '', calc.ot];

  if (rec) {
    data.sh.getRange(rec.row, COL.IN + 1, 1, status.length).setValues([status]);
    data.sh.getRange(rec.row, COL.OVERRIDE + 1, 1, 2).setValues([[e.override, note]]);
    return { created: false, before: entryText_(rec) };
  }
  const row = new Array(ATT_HEADERS.length).fill('');
  row[COL.DATE] = "'" + date;
  row[COL.EMP] = emp.id;
  row[COL.NAME] = emp.name;
  status.forEach((v, i) => { row[COL.IN + i] = v; });
  row[COL.OVERRIDE] = e.override;
  row[COL.NOTE] = note;
  data.newRows.push(row);
  data.map[emp.id + '|' + date] = { row: -1 }; // avoid duplicates within one batch
  return { created: true, before: '(none)' };
}

function entryText_(e) {
  return [e.in ? 'in ' + e.in : '', e.out ? 'out ' + e.out : '', e.override || ''].filter(String).join(' ') || '(empty)';
}

function audit_(byEmp, action, empId, date, details) {
  const sh = getOrCreate_(SpreadsheetApp.getActive(), SHEET.AUDIT, AUDIT_HEADERS);
  sh.appendRow([Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss'), byEmp.id + ' ' + byEmp.name,
    action, empId, date, details]);
}

function addDays_(dateStr, n) {
  const p = dateStr.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + n);
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

/* ------------------------------------------------------------------ */
/* Attendance / salary calculation                                     */
/* ------------------------------------------------------------------ */

function buildMonth_(emp, ym) {
  const s = getSettings_();
  const att = readAttendance_().filter(r => r.date.indexOf(ym) === 0);
  const m = monthSummary_(emp, ym, s, byDate_(att, emp.id), getHolidays_());
  m.employee = { id: emp.id, name: emp.name };
  m.ym = ym;
  m.label = ymLabel_(ym);
  m.currency = s.currency;
  m.inProgress = ym === todayStr_().slice(0, 7);
  m.rules = {
    shiftStart: minutesToStr_(s.shiftStartMin), lateGrace: s.lateGrace, standardHours: s.standardHours,
    otMultiplier: s.otMultiplier, latesPerHalfDay: s.latesPerHalfDay, salaryDays: s.salaryDays,
    lateReducesOt: s.lateReducesOt, adjustIn: s.adjustIn,
  };
  return m;
}

/**
 * Status of one attendance record.
 * offType: '' for a working day, 'WEEK_OFF' or 'HOLIDAY' otherwise.
 */
function evaluateDay_(rec, s, offType, isToday) {
  const inMin = toMinutes_(rec.in);
  const outMin = toMinutes_(rec.out);
  const d = { in: rec.in || '', out: rec.out || '', worked: 0, ot: 0, late: false, status: '' };
  if (inMin != null && outMin != null && outMin > inMin) d.worked = round2_((outMin - inMin) / 60);

  if (rec.override) d.status = rec.override;
  else if (offType) d.status = inMin != null ? 'OFF_WORK' : offType;
  else if (inMin == null) d.status = 'ABSENT';
  else if (outMin == null) d.status = isToday ? 'WORKING' : s.noCheckoutStatus;
  else if (d.worked >= s.fullDayHours) d.status = 'PRESENT';
  else if (d.worked >= s.halfDayHours) d.status = 'HALF_DAY';
  else d.status = 'ABSENT';

  // An admin override replaces the automatic status and clears the late mark.
  d.late = !rec.override && !offType && inMin != null && inMin > s.shiftStartMin + s.lateGrace;
  d.lateMin = d.late ? inMin - s.shiftStartMin : 0;

  const workedMin = inMin != null && outMin != null && outMin > inMin ? outMin - inMin : 0;
  let otMin = 0;
  if (d.status !== 'ABSENT') {
    otMin = offType ? (s.offDayOt ? workedMin : 0) : Math.max(0, workedMin - s.standardHours * 60);
  }
  if (s.otBlock > 0) otMin = Math.floor(otMin / s.otBlock) * s.otBlock;
  d.otMin = otMin;
  d.ot = round2_(otMin / 60);
  return d;
}

function monthSummary_(emp, ym, s, attByDate, holidays) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const dim = new Date(y, m, 0).getDate();
  const today = todayStr_();
  const t = {
    daysInMonth: dim, present: 0, halfDay: 0, absent: 0, leave: 0, weekOff: 0, holiday: 0, offWork: 0,
    notJoined: 0, late: 0, lateMin: 0, workedHours: 0, otMinGross: 0, otMin: 0, otHours: 0,
    deductDays: 0, lateCutDays: 0, payableDays: 0,
  };
  const days = [];

  for (let day = 1; day <= dim; day++) {
    const ds = ym + '-' + pad2_(day);
    const off = offType_(ds, s, holidays);
    const rec = attByDate[ds];
    let d;
    if (emp.joinDate && ds < emp.joinDate) d = { status: 'NOT_JOINED' };
    else if (ds > today) d = { status: off || 'UPCOMING' };
    else if (rec) d = evaluateDay_(rec, s, off, ds === today);
    else if (off) d = { status: off };
    else d = { status: ds === today ? 'NOT_MARKED' : 'ABSENT' };

    d.date = ds;
    d.day = day;
    d.dow = new Date(y, m - 1, day).getDay();
    if (off === 'HOLIDAY') d.holidayName = holidays[ds];
    if (rec && rec.note) d.note = String(rec.note);
    days.push(d);

    switch (d.status) {
      case 'PRESENT': case 'WORKING': t.present++; break;
      case 'HALF_DAY': t.halfDay++; t.deductDays += 0.5; break;
      case 'ABSENT': t.absent++; t.deductDays += 1; break;
      case 'LEAVE': t.leave++; break;
      case 'WEEK_OFF': t.weekOff++; break;
      case 'HOLIDAY': t.holiday++; break;
      case 'OFF_WORK': t.offWork++; break;
      case 'NOT_JOINED': t.notJoined++; t.deductDays += 1; break;
    }
    if (d.late) { t.late++; t.lateMin += d.lateMin || 0; }
    t.workedHours += d.worked || 0;
    t.otMinGross += d.otMin || 0;
  }

  // Net OT = all OT minutes in the month − all late minutes in the month (never below zero).
  t.otMin = Math.max(0, t.otMinGross - (s.lateReducesOt ? t.lateMin : 0));
  t.otHours = round2_(t.otMin / 60);
  t.workedHours = round2_(t.workedHours);
  t.lateCutDays = s.latesPerHalfDay > 0 ? Math.floor(t.late / s.latesPerHalfDay) * 0.5 : 0;
  t.deductDays += t.lateCutDays;
  t.payableDays = Math.max(0, dim - t.deductDays);

  return { totals: t, pay: calcPay_(emp, s, t, dim), days: days };
}

/**
 * Salary for the month.
 *   Per day = salary ÷ Salary Days Basis (30), per hour = per day ÷ Standard Hours, per minute = per hour ÷ 60.
 *   Gross   = salary + OT pay − leave − half-day − late-cut deductions.
 * PF employees: Bank = PF Bank Salary − PF Employee, Cash = Salary − PF Bank Salary, and OT/deductions
 * are applied to Cash (or Bank, per the "OT & Deductions Paid In" setting).
 */
function calcPay_(emp, s, t, dim) {
  const basis = s.salaryDays > 0 ? s.salaryDays : dim;
  const perDay = emp.salary / basis;
  const perHour = s.standardHours > 0 ? perDay / s.standardHours : 0;
  const perMin = perHour / 60;

  const leaveDed = (t.absent + t.notJoined) * perDay;
  const halfDayDed = t.halfDay * 0.5 * perDay;
  const lateCutDed = t.lateCutDays * perDay;
  const deduction = Math.min(emp.salary, leaveDed + halfDayDed + lateCutDed);
  const otPay = t.otMin * perMin * s.otMultiplier;
  const gross = emp.salary - deduction + otPay;

  const pay = {
    salary: round2_(emp.salary), perDay: round2_(perDay), hourly: round2_(perHour), perMin: round2_(perMin),
    leaveDed: round2_(leaveDed), halfDayDed: round2_(halfDayDed), lateCutDed: round2_(lateCutDed),
    deduction: round2_(deduction), otPay: round2_(otPay), gross: round2_(gross),
    pf: false, pfBankSalary: 0, pfEmployee: 0, pfEmployer: 0, bank: 0, cash: 0, net: round2_(gross),
  };
  if (!emp.pf.active) return pay;

  const pf = pfAmounts_(emp, s);
  let bank, cash;
  if (s.adjustIn === 'BANK') {
    cash = emp.salary - pf.bankSalary;
    bank = gross - cash - pf.employee;
  } else {
    bank = pf.bankSalary - pf.employee;
    cash = gross - pf.bankSalary;
  }
  // If deductions are bigger than one part, take the rest from the other part.
  if (cash < 0) { bank += cash; cash = 0; }
  if (bank < 0) { cash += bank; bank = 0; }
  cash = Math.max(0, cash);

  return Object.assign(pay, {
    pf: true, pfBankSalary: round2_(pf.bankSalary), pfEmployee: round2_(pf.employee),
    pfEmployer: round2_(pf.employer), bank: round2_(bank), cash: round2_(cash), net: round2_(bank + cash),
  });
}

/** PF amounts for an employee. Blank cells fall back to the % defaults in Settings; "12%" style is also accepted. */
function pfAmounts_(emp, s) {
  const amt = (v, pct, base) => {
    const str = String(v === undefined || v === null ? '' : v).trim();
    if (!str) return base * pct / 100;
    if (/%$/.test(str)) return base * (Number(str.replace('%', '')) || 0) / 100;
    return Number(str) || 0;
  };
  const bankSalary = Math.min(emp.salary, amt(emp.pf.bankSalary, s.pfBankPct, emp.salary));
  return {
    bankSalary: bankSalary,
    employee: amt(emp.pf.employee, s.pfEmployeePct, bankSalary),
    employer: amt(emp.pf.employer, s.pfEmployerPct, bankSalary),
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function auth_(token) {
  const empId = token ? CacheService.getScriptCache().get('tok_' + token) : null;
  if (!empId) throw new Error('SESSION_EXPIRED');
  const emp = findEmployee_(empId);
  if (!emp || !emp.active) throw new Error('SESSION_EXPIRED');
  return emp;
}

function profile_(emp) {
  const p = permsFor_(emp);
  delete p.employees;
  return { id: emp.id, name: emp.name, role: emp.role, perms: p };
}

function serverClock_() {
  const now = new Date();
  return { epoch: now.getTime(), local: Utilities.formatDate(now, tz_(), 'yyyy-MM-dd HH:mm:ss') };
}

/**
 * Rejects check-in/out when the phone's clock or time zone is wrong — the usual sign that
 * "Automatic date & time" is switched off. phoneClock = { epoch: Date.now(), local: 'yyyy-MM-dd HH:mm:ss' }.
 * (Recorded times always come from the server; this check just enforces the policy.)
 */
function checkPhoneClock_(s, phoneClock) {
  const msg = 'Your phone time is not correct. Open phone Settings → Date & time → turn ON ' +
    '"Automatic date & time" and "Automatic time zone", then reopen the app.';
  if (!phoneClock || !phoneClock.epoch || !phoneClock.local) throw new Error('Please reload the app and try again.');
  const tol = Math.max(1, s.clockTolerance) * 60000;
  const server = serverClock_();
  if (!(Math.abs(Number(phoneClock.epoch) - server.epoch) <= tol)) throw new Error(msg);
  if (!(Math.abs(wallMs_(phoneClock.local) - wallMs_(server.local)) <= tol)) throw new Error(msg);
}

/** 'yyyy-MM-dd HH:mm:ss' wall-clock text → comparable milliseconds. */
function wallMs_(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(str));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function checkLocation_(s, lat, lng, acc) {
  if (!isFinite(s.officeLat) || !isFinite(s.officeLng)) {
    throw new Error('Office location is not set. Ask the admin to fill Office Latitude/Longitude in Settings.');
  }
  lat = Number(lat); lng = Number(lng); acc = Number(acc);
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
    throw new Error('Location not received. Turn on GPS and allow location access.');
  }
  if (isFinite(acc) && acc > s.maxAccuracy) {
    throw new Error('GPS signal is weak (±' + Math.round(acc) + ' m). Move near a window or open area and try again.');
  }
  const dist = distanceM_(lat, lng, s.officeLat, s.officeLng);
  if (dist > s.radius) {
    throw new Error('You are ' + Math.round(dist) + ' m from the office. You must be within ' + s.radius +
      ' m to mark attendance.');
  }
  return { lat: lat, lng: lng, acc: isFinite(acc) ? Math.round(acc) : '', dist: Math.round(dist) };
}

/** Haversine distance in metres. */
function distanceM_(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function saveSelfie_(dataUrl, fileName, s) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Selfie missing. Please take a selfie to check in.');
  if (m[2].length > 4000000) throw new Error('Selfie is too large. Please try again.');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), 'image/' + m[1], fileName);
  return getSelfieFolder_(s).createFile(blob).getUrl();
}

function getSelfieFolder_(s) {
  if (s.selfieFolderId) {
    try { return DriveApp.getFolderById(s.selfieFolderId); } catch (e) { /* recreate below */ }
  }
  const folder = DriveApp.createFolder(s.company + ' – Attendance Selfies');
  setSetting_('Selfie Folder ID', folder.getId());
  return folder;
}

function getSettings_() {
  if (getSettings_.cache) return getSettings_.cache;
  const raw = {};
  sheet_(SHEET.SETTINGS).getDataRange().getValues().slice(1).forEach(r => {
    if (String(r[0]).trim()) raw[String(r[0]).trim()] = r[1];
  });
  const blank = k => raw[k] === undefined || raw[k] === null || String(raw[k]).trim() === '';
  const num = (k, def) => (blank(k) || isNaN(Number(raw[k])) ? def : Number(raw[k]));
  const yes = (k, def) => (blank(k) ? def : /^(y|yes|true|1)$/i.test(String(raw[k]).trim()));
  const str = (k, def) => (blank(k) ? def : String(raw[k]).trim());

  const dayIdx = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const weeklyOff = str('Weekly Off', 'Sunday').split(/[,;\s]+/)
    .map(x => dayIdx[x.trim().slice(0, 3).toLowerCase()])
    .filter(x => x !== undefined);
  const noCheckout = str('No Check-Out Counts As', 'HALF_DAY').toUpperCase().replace(/[\s-]+/g, '_');
  const shiftStart = toMinutes_(raw['Shift Start']);

  getSettings_.cache = {
    company: str('Company Name', 'Attendance'),
    officeLat: num('Office Latitude', NaN),
    officeLng: num('Office Longitude', NaN),
    radius: num('Allowed Radius (m)', 30),
    maxAccuracy: num('Max GPS Accuracy (m)', 50),
    checkoutLocation: yes('Check Location On Check-Out', true),
    selfieRequired: yes('Selfie Required', true),
    shiftStartMin: shiftStart == null ? 570 : shiftStart,
    lateGrace: num('Late Grace (min)', 10),
    standardHours: num('Standard Hours', 9),
    fullDayHours: num('Full Day Min Hours', 8),
    halfDayHours: num('Half Day Min Hours', 4),
    noCheckoutStatus: ['PRESENT', 'HALF_DAY', 'ABSENT'].indexOf(noCheckout) >= 0 ? noCheckout : 'HALF_DAY',
    otMultiplier: num('OT Multiplier', 1.5),
    otBlock: num('OT Block (min)', 0),
    salaryDays: num('Salary Days Basis', 30),
    lateReducesOt: yes('Late Minutes Reduce OT', true),
    clockTolerance: num('Phone Time Tolerance (min)', 3),
    pfBankPct: num('Default PF Bank Salary %', 90),
    pfEmployeePct: num('Default PF Employee %', 12),
    pfEmployerPct: num('Default PF Employer %', 13),
    adjustIn: str('OT & Deductions Paid In', 'CASH').toUpperCase() === 'BANK' ? 'BANK' : 'CASH',
    weeklyOff: weeklyOff,
    offDayOt: yes('Off-Day Work Is OT', true),
    latesPerHalfDay: num('Lates Per Half-Day Cut', 0),
    backDateDays: num('Admin Back-Date Limit (days)', 45),
    currency: str('Currency', '₹'),
    selfieFolderId: str('Selfie Folder ID', ''),
  };
  return getSettings_.cache;
}

function setSetting_(key, value) {
  const sh = sheet_(SHEET.SETTINGS);
  const keys = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(r => String(r[0]).trim());
  const i = keys.indexOf(key);
  if (i >= 0) sh.getRange(i + 1, 2).setValue(value);
  else sh.appendRow([key, value, '']);
  delete getSettings_.cache;
}

function getEmployees_() {
  const sh = sheet_(SHEET.EMPLOYEES);
  const values = sh.getDataRange().getValues();
  const h = headerIndex_(sh, values[0]);
  const get = (r, name) => (h[name] === undefined ? '' : r[h[name]]);
  return values.slice(1)
    .map((r, i) => ({ r: r, row: i + 2 }))
    .filter(x => String(x.r[0]).trim())
    .map(x => {
      const r = x.r;
      return {
        row: x.row,
        id: String(r[0]).trim().toUpperCase(),
        name: String(r[1]).trim(),
        pin: String(r[2]).trim(),
        salary: Number(r[3]) || 0,
        role: parseRole_(r[4]),
        active: !/^(n|no|false|0|inactive)$/i.test(String(r[5]).trim()),
        joinDate: toDateStr_(r[6]),
        pf: {
          active: /^(y|yes|true|1|on)$/i.test(String(get(r, 'PF Active')).trim()),
          bankSalary: get(r, 'PF Bank Salary'),
          employee: get(r, 'PF Employee'),
          employer: get(r, 'PF Employer'),
        },
      };
    });
}

/** { 'Header name': columnIndex (0-based) } */
function parseRole_(v) {
  const r = String(v || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (r === 'SUPER_ADMIN' || r === 'SUPERADMIN') return 'SUPER_ADMIN';
  return r === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';
}

function headerIndex_(sh, headerRow) {
  const row = headerRow || sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  const map = {};
  row.forEach((v, i) => { if (String(v).trim()) map[String(v).trim()] = i; });
  return map;
}

/** Adds any missing headers to the end of row 1 (used when upgrading an existing sheet). */
function ensureHeaders_(sh, headers) {
  const have = headerIndex_(sh);
  let col = sh.getLastColumn();
  headers.forEach(name => {
    if (have[name] === undefined) {
      col++;
      sh.getRange(1, col).setValue(name).setFontWeight('bold').setBackground('#e8eefc');
    }
  });
}

function findEmployee_(empId) {
  return getEmployees_().filter(e => e.id === empId)[0] || null;
}

function readAttendance_() {
  const sh = sheet_(SHEET.ATTENDANCE);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, ATT_HEADERS.length).getValues().map((r, i) => {
    const ov = String(r[COL.OVERRIDE]).trim().toUpperCase().replace(/[\s-]+/g, '_');
    return {
      row: i + 2,
      date: toDateStr_(r[COL.DATE]),
      empId: String(r[COL.EMP]).trim().replace(/^'/, '').toUpperCase(),
      in: toTimeStr_(r[COL.IN]),
      out: toTimeStr_(r[COL.OUT]),
      inDist: r[COL.IN_DIST],
      selfie: String(r[COL.SELFIE] || ''),
      override: OVERRIDE_VALUES.indexOf(ov) >= 0 ? ov : '',
      note: r[COL.NOTE],
    };
  }).filter(a => a.date && a.empId);
}

function byDate_(att, empId) {
  const map = {};
  att.forEach(r => { if (r.empId === empId && !map[r.date]) map[r.date] = r; });
  return map;
}

function getHolidays_() {
  const sh = sheet_(SHEET.HOLIDAYS);
  const map = {};
  sh.getDataRange().getValues().slice(1).forEach(r => {
    const d = toDateStr_(r[0]);
    if (d) map[d] = String(r[1] || 'Holiday');
  });
  return map;
}

function offType_(dateStr, s, holidays) {
  if (holidays[dateStr]) return 'HOLIDAY';
  const p = dateStr.split('-').map(Number);
  return s.weeklyOff.indexOf(new Date(p[0], p[1] - 1, p[2]).getDay()) >= 0 ? 'WEEK_OFF' : '';
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" not found. Run setup() from the Apps Script editor.');
  return sh;
}

function getOrCreate_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eefc');
    sh.setFrozenRows(1);
  }
  return sh;
}

function tz_() {
  return SpreadsheetApp.getActive().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
}

function todayStr_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function toDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const str = String(v || '').trim().replace(/^'/, '');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str);
  if (m) return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(str); // dd/MM/yyyy
  if (m) return m[3] + '-' + pad2_(m[2]) + '-' + pad2_(m[1]);
  return '';
}

function toTimeStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'HH:mm');
  const m = /(\d{1,2}):(\d{2})/.exec(String(v || ''));
  return m ? pad2_(m[1]) + ':' + m[2] : '';
}

function toMinutes_(v) {
  const t = toTimeStr_(v);
  if (!t) return null;
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

function minutesToStr_(min) {
  return pad2_(Math.floor(min / 60)) + ':' + pad2_(min % 60);
}

function validYm_(ym) {
  ym = String(ym || '');
  return /^\d{4}-\d{2}$/.test(ym) ? ym : todayStr_().slice(0, 7);
}

function ymLabel_(ym) {
  const p = ym.split('-').map(Number);
  return Utilities.formatDate(new Date(p[0], p[1] - 1, 15), tz_(), 'MMMM yyyy');
}

function pad2_(n) {
  return ('0' + n).slice(-2);
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}
