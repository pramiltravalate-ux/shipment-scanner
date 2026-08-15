/* ══════════════════════════════════════════════
   DAILY TASK SHEET TRACKER — Apps Script backend
   ------------------------------------------------------------
   Container-bound to a Google Sheet. Stores one row per task in
   a "DailyTasks" tab (auto-created on first run) and serves the
   Index.html front end as a Web App. All reads/writes happen
   through the functions below, called from the client via
   google.script.run.
══════════════════════════════════════════════ */

const SHEET_NAME = 'DailyTasks';
const HEADERS = ['ID', 'Date', 'Status', 'SortOrder', 'Name', 'Priority', 'Tags', 'Labels', 'Subtasks', 'CreatedAt', 'UpdatedAt'];
const STATUSES = ['todo', 'progress', 'complete'];

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Daily Task Sheet Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function readAll_() {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  return { sh, headers, rows: values.slice(1) };
}

function safeParse_(json, fallback) {
  if (!json) return fallback;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

function rowToTask_(headers, row) {
  const c = name => row[headers.indexOf(name)];
  return {
    id: String(c('ID')),
    date: String(c('Date')),
    status: c('Status') || 'todo',
    sortOrder: Number(c('SortOrder')) || 0,
    name: c('Name') || '',
    priority: c('Priority') || null,
    tags: safeParse_(c('Tags'), []),
    labels: safeParse_(c('Labels'), []),
    subtasks: safeParse_(c('Subtasks'), [])
  };
}

function taskToRow_(headers, task, createdAt) {
  return headers.map(h => {
    switch (h) {
      case 'ID': return task.id;
      case 'Date': return task.date;
      case 'Status': return STATUSES.indexOf(task.status) >= 0 ? task.status : 'todo';
      case 'SortOrder': return Number(task.sortOrder) || 0;
      case 'Name': return String(task.name || '').slice(0, 500);
      case 'Priority': return task.priority || '';
      case 'Tags': return JSON.stringify((task.tags || []).slice(0, 30));
      case 'Labels': return JSON.stringify((task.labels || []).slice(0, 30));
      case 'Subtasks': return JSON.stringify((task.subtasks || []).slice(0, 100));
      case 'CreatedAt': return createdAt;
      case 'UpdatedAt': return new Date().toISOString();
      default: return '';
    }
  });
}

/** Returns every task for a given YYYY-MM-DD date, ordered by group sort order. */
function getTasksForDate(dateStr) {
  const { headers, rows } = readAll_();
  const dateCol = headers.indexOf('Date');
  return rows
    .filter(row => String(row[dateCol]) === dateStr)
    .map(row => rowToTask_(headers, row))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Creates a new blank task row on the given date/status and returns it. */
function createTask(dateStr, status) {
  if (!dateStr) throw new Error('A date is required.');
  return withLock_(() => {
    const sh = getSheet_();
    const id = Utilities.getUuid();
    const now = new Date().toISOString();
    const siblings = getTasksForDate(dateStr).filter(t => t.status === (status || 'todo'));
    const sortOrder = siblings.length ? Math.max.apply(null, siblings.map(t => t.sortOrder)) + 1 : 1;
    const task = { id, date: dateStr, status: status || 'todo', sortOrder, name: 'New task', priority: null, tags: [], labels: [], subtasks: [] };
    sh.appendRow(taskToRow_(HEADERS, task, now));
    return task;
  });
}

function findRowIndexById_(headers, rows, id) {
  const idCol = headers.indexOf('ID');
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][idCol]) === String(id)) return i + 2; // +1 header row, +1 1-indexed
  }
  return -1;
}

/** Upserts every field of an existing task in one write (name, status, priority, tags, labels, subtasks). */
function saveTask(task) {
  if (!task || !task.id) throw new Error('Task id is required.');
  return withLock_(() => {
    const { sh, headers, rows } = readAll_();
    const rowIndex = findRowIndexById_(headers, rows, task.id);
    if (rowIndex === -1) throw new Error('Task not found — it may have been deleted elsewhere.');
    const createdAt = rows[rowIndex - 2][headers.indexOf('CreatedAt')];
    sh.getRange(rowIndex, 1, 1, headers.length).setValues([taskToRow_(headers, task, createdAt)]);
    return task;
  });
}

function deleteTask(id) {
  return withLock_(() => {
    const { sh, headers, rows } = readAll_();
    const rowIndex = findRowIndexById_(headers, rows, id);
    if (rowIndex !== -1) sh.deleteRow(rowIndex);
    return { success: true };
  });
}

/** Copies every incomplete task from the most recent earlier day that has
 *  tasks onto dateStr, skipping any task whose name already exists there. */
function carryOverOpenTasks(dateStr) {
  return withLock_(() => {
    const sh = getSheet_();
    const { headers, rows } = readAll_();
    const dateCol = headers.indexOf('Date');
    const earlierDates = {};
    rows.forEach(row => {
      const d = String(row[dateCol]);
      if (d < dateStr) earlierDates[d] = true;
    });
    const dates = Object.keys(earlierDates).sort();
    if (!dates.length) return { added: 0, sourceDate: null, message: 'No earlier day with tasks was found.' };

    const sourceDate = dates[dates.length - 1];
    const sourceTasks = getTasksForDate(sourceDate).filter(t => t.status !== 'complete');
    if (!sourceTasks.length) return { added: 0, sourceDate, message: 'No open tasks found on ' + sourceDate + '.' };

    const targetTasks = getTasksForDate(dateStr);
    const existingNames = {};
    targetTasks.forEach(t => { existingNames[t.name] = true; });

    let sortOrder = targetTasks.filter(t => t.status === 'todo').reduce((max, t) => Math.max(max, t.sortOrder), 0) + 1;
    const now = new Date().toISOString();
    let added = 0;
    sourceTasks.forEach(t => {
      if (existingNames[t.name]) return;
      const newTask = {
        id: Utilities.getUuid(),
        date: dateStr,
        status: 'todo',
        sortOrder: sortOrder++,
        name: t.name,
        priority: t.priority,
        tags: t.tags,
        labels: t.labels,
        subtasks: (t.subtasks || []).map(s => ({ id: Utilities.getUuid(), text: s.text, done: false }))
      };
      sh.appendRow(taskToRow_(HEADERS, newTask, now));
      added++;
    });
    return { added, sourceDate };
  });
}
