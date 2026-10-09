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
};

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
    .requireValueInList(['EMPLOYEE', 'ADMIN'], true).build());
  const yesNo = SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).build();
  sh.getRange('F2:F').setDataValidation(yesNo);
  const pfCol = headerIndex_(sh)['PF Active'] + 1;
  sh.getRange(2, pfCol, sh.getMaxRows() - 1, 1).setDataValidation(yesNo);
  if (sh.getLastRow() < 2) {
    sh.appendRow(['E001', 'Admin', '1234', 30000, 'ADMIN', 'Yes', todayStr_(), '', 'No', '', '', '']);
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

function adminToday(token) {
  auth_(token, true);
  const s = getSettings_();
  const today = todayStr_();
  const offType = offType_(today, s, getHolidays_());
  const recs = {};
  readAttendance_().forEach(r => { if (r.date === today && !recs[r.empId]) recs[r.empId] = r; });

  const counts = { total: 0, in: 0, late: 0, out: 0, notMarked: 0 };
  const list = getEmployees_().filter(e => e.active).map(e => {
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
  auth_(token, true);
  ym = validYm_(ym);
  const s = getSettings_();
  const holidays = getHolidays_();
  const att = readAttendance_().filter(r => r.date.indexOf(ym) === 0);
  const withRecords = {};
  att.forEach(r => { withRecords[r.empId] = true; });

  const rows = getEmployees_().filter(e => e.active || withRecords[e.id]).map(e => {
    const m = monthSummary_(e, ym, s, byDate_(att, e.id), holidays);
    return Object.assign({ id: e.id, name: e.name }, m.totals, m.pay);
  });
  return { ym: ym, label: ymLabel_(ym), currency: s.currency, rows: rows };
}

function adminEmployeeMonth(token, empId, ym) {
  auth_(token, true);
  const emp = findEmployee_(String(empId).toUpperCase());
  if (!emp) throw new Error('Employee not found.');
  return buildMonth_(emp, validYm_(ym));
}

/** Employee list with PF settings for the admin "Employees / PF" screen. */
function adminEmployees(token) {
  auth_(token, true);
  const s = getSettings_();
  return {
    currency: s.currency,
    defaults: { bank: s.pfBankPct, employee: s.pfEmployeePct, employer: s.pfEmployerPct },
    list: getEmployees_().filter(e => e.active).map(e => {
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
  auth_(token, true);
  const emp = findEmployee_(String(empId).toUpperCase());
  if (!emp) throw new Error('Employee not found.');
  const clean = v => {
    const str = String(v === undefined || v === null ? '' : v).trim();
    if (!str) return '';
    if (/^\d+(\.\d+)?%$/.test(str)) return str;
    if (isNaN(Number(str)) || Number(str) < 0) throw new Error('Invalid amount: ' + str);
    return Number(str);
  };
  const sh = sheet_(SHEET.EMPLOYEES);
  ensureHeaders_(sh, EMP_HEADERS);
  const h = headerIndex_(sh);
  sh.getRange(emp.row, h['PF Active'] + 1).setValue(data && data.active ? 'Yes' : 'No');
  sh.getRange(emp.row, h['PF Bank Salary'] + 1).setValue(clean(data && data.bankSalary));
  sh.getRange(emp.row, h['PF Employee'] + 1).setValue(clean(data && data.employee));
  sh.getRange(emp.row, h['PF Employer'] + 1).setValue(clean(data && data.employer));
  SpreadsheetApp.flush();
  return adminEmployees(token);
}

/** Returns the check-in selfie as a data URL so admins can view it inside the app. */
function adminGetSelfie(token, row) {
  auth_(token, true);
  const url = String(sheet_(SHEET.ATTENDANCE).getRange(Number(row), COL.SELFIE + 1).getValue());
  const m = /\/d\/([\w-]+)/.exec(url) || /id=([\w-]+)/.exec(url);
  if (!m) throw new Error('No selfie for this entry.');
  const blob = DriveApp.getFileById(m[1]).getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/** Writes a "Payroll yyyy-MM" tab with every employee's salary for the month. */
function adminExportPayroll(token, ym) {
  const data = adminMonth(token, ym);
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
  return { url: ss.getUrl() + '#gid=' + sh.getSheetId(), sheet: name };
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

function auth_(token, needAdmin) {
  const empId = token ? CacheService.getScriptCache().get('tok_' + token) : null;
  if (!empId) throw new Error('SESSION_EXPIRED');
  const emp = findEmployee_(empId);
  if (!emp || !emp.active) throw new Error('SESSION_EXPIRED');
  if (needAdmin && emp.role !== 'ADMIN') throw new Error('Admin access only.');
  return emp;
}

function profile_(emp) {
  return { id: emp.id, name: emp.name, role: emp.role };
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
        role: String(r[4]).trim().toUpperCase() === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
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
