// ============================================================
//  INVENTORY MANAGEMENT SYSTEM - Google Apps Script
//  Tabs: Master_SKU | Transactions | Opening_Stock
//  Stock sheet: auto-named e.g. "June-26", "July-26" etc.
//  PERFORMANCE: All sheet reads/writes are batched
// ============================================================

const CONFIG = {
  SHEETS: {
    MASTER_SKU:    "Master_SKU",
    TRANSACTIONS:  "Transactions",
    OPENING_STOCK: "Opening_Stock",
    COMBOS:        "Combos",
    FAVORITES:     "Favorites",
  },
  LOW_STOCK_THRESHOLD: 50,
};

// Weekly report recipients (Admin emails)
const REPORT_EMAILS = [
  "pramiltravalate@gmail.com",
  "venu.sethi@gmail.com",
];

// ─────────────────────────────────────────────────────────────
//  COMBO SKUs  —  now stored dynamically in the "Combos" sheet
//  (created automatically if missing). No more hardcoding here.
//
//  Combos sheet layout:
//    Column A: Combo SKU name
//    Column B onward: Component SKU 1, Component SKU 2, Component SKU 3 ...
//    (a row can have 2 or more components, trailing cells left blank)
//
//  A combo SKU is NOT independently stocked. Selling/using 1 unit
//  of a combo deducts 1 unit from EACH of its component SKUs.
//  The combo's displayed stock = MIN(component stocks).
//  Combo entries are OUTWARD ONLY.
// ─────────────────────────────────────────────────────────────

/** Ensures the Combos sheet exists; creates it with headers if missing. */
function getOrCreateCombosSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEETS.COMBOS);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEETS.COMBOS);
    sh.getRange(1, 1, 1, 6).setValues([[
      "Combo SKU", "Component 1", "Component 2", "Component 3", "Component 4", "Component 5"
    ]]);
    sh.getRange(1, 1, 1, 6).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#FFFFFF");
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Reads the Combos sheet and returns { "COMBO-SKU": ["COMP1","COMP2",...], ... } */
function loadCombos() {
  const sh   = getOrCreateCombosSheet();
  const data = sh.getDataRange().getValues();
  const map  = {};
  for (let r = 1; r < data.length; r++) {
    const comboName = String(data[r][0] || "").trim();
    if (!comboName) continue;
    const components = data[r].slice(1)
      .map(c => String(c || "").trim())
      .filter(c => c.length > 0);
    if (components.length >= 2) {
      map[comboName.toUpperCase()] = components;
    }
  }
  return map;
}

function isComboSKU(sku, preloadedCombos) {
  const combos = preloadedCombos || loadCombos();
  return Object.prototype.hasOwnProperty.call(combos, String(sku).trim().toUpperCase());
}
function getComboComponents(sku, preloadedCombos) {
  const combos = preloadedCombos || loadCombos();
  return combos[String(sku).trim().toUpperCase()] || [];
}

// ─────────────────────────────────────────────────────────────
//  FAVORITE SKUs (for weekly Top-Products report)
//  Stored in the "Favorites" sheet. Only Admin can star/unstar
//  SKUs via the Admin panel.
//
//  Favorites sheet layout:
//    Column A: SKU name (marked as favorite)
// ─────────────────────────────────────────────────────────────
function getOrCreateFavoritesSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEETS.FAVORITES);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEETS.FAVORITES);
    sh.getRange(1, 1, 1, 1).setValues([["Favorite SKU"]]);
    sh.getRange(1, 1, 1, 1).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#FFFFFF");
    sh.setFrozenRows(1);
  }
  return sh;
}

function loadFavorites() {
  const sh   = getOrCreateFavoritesSheet();
  const data = sh.getRange("A2:A" + Math.max(sh.getLastRow(), 2)).getValues();
  return data.map(r => String(r[0] || "").trim()).filter(s => s.length > 0);
}

/** Returns favorites for display purposes (any user can VIEW which are starred). */
function getFavorites() {
  return loadFavorites();
}

/** Toggles a SKU's favorite status. Requires a valid Admin PIN. */
function toggleFavorite(adminCode, sku) {
  const adminCheck = verifyAdminCode(adminCode);
  if (!adminCheck.valid) return { success: false, error: "Not authorised. Admin PIN required." };

  const skuName = String(sku).trim();
  if (!skuName) return { success: false, error: "No SKU specified." };

  const sh = getOrCreateFavoritesSheet();
  const favorites = loadFavorites();
  const existingIdx = favorites.findIndex(f => f.toUpperCase() === skuName.toUpperCase());

  if (existingIdx === -1) {
    // Add as favorite
    sh.appendRow([skuName]);
    return { success: true, isFavorite: true };
  } else {
    // Remove from favorites
    sh.deleteRow(existingIdx + 2); // +2: header row + 1-based index
    return { success: true, isFavorite: false };
  }
}


const MONTHS_LONG  = ["January","February","March","April","May","June",
                      "July","August","September","October","November","December"];
const MONTHS_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN",
                      "JUL","AUG","SEP","OCT","NOV","DEC"];

// ─────────────────────────────────────────────────────────────
//  ACTIVE STOCK SHEET RESOLVER
//  Always returns the correct month's sheet automatically.
//  Sheet name format: "June-26", "July-26" etc.
// ─────────────────────────────────────────────────────────────
function getActiveStockSheet() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const now   = new Date();
  const name  = MONTHS_LONG[now.getMonth()] + "-" + String(now.getFullYear()).slice(-2);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("Stock sheet '" + name + "' not found. Has the monthly rollover run?");
  return sheet;
}

/** Title-cases a "DD-MON" style header (e.g. "27-JUN" -> "27-Jun") for
 *  nicer display; leaves anything else untouched. */
function prettifyDateHeader_(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]+)$/);
  if (!m) return s;
  const mon = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  return m[1] + "-" + mon;
}

// ─────────────────────────────────────────────────────────────
//  getInventorySnapshot()  —  powers the Dashboard's spreadsheet-style
//  "Inventory Snapshot" view: every SKU × every date column in this
//  month's active Stock Register sheet, values as-is, plus each cell's
//  note (the day's transaction comments, if any) so the client can show
//  them without a second round-trip.
// ─────────────────────────────────────────────────────────────
function getInventorySnapshot() {
  try {
    const srSh = getActiveStockSheet();
    const lastRow = srSh.getLastRow();
    const lastCol = srSh.getLastColumn();

    const now = new Date();
    const monthLabel = MONTHS_LONG[now.getMonth()] + " - " + now.getFullYear();

    if (lastRow < 2 || lastCol < 2) {
      return { success: true, monthLabel, dates: [], rows: [] };
    }

    const range  = srSh.getRange(1, 1, lastRow, lastCol);
    const values = range.getValues();
    const notes  = range.getNotes();
    const headerRow = values[0];

    // Natural chronological order (oldest -> newest, latest column last) —
    // matches the underlying sheet. The client owns which end the latest
    // date appears at (toggleable "Sort" control) and auto-scrolls to
    // reveal it, so this only needs to be correct and consistent, not
    // pre-reversed.
    const dates = [];
    for (let c = 1; c < headerRow.length; c++) {
      const h = headerRow[c];
      dates.push(h instanceof Date ? prettifyDateHeader_(formatDDMON(h)) : prettifyDateHeader_(h));
    }

    const rows = [];
    for (let r = 1; r < values.length; r++) {
      const sku = String(values[r][0] || "").trim();
      if (!sku) continue;
      const rowValues = [];
      const rowNotes  = [];
      for (let c = 1; c < headerRow.length; c++) {
        const v = values[r][c];
        rowValues.push(v === "" || v === null || v === undefined ? "" : v);
        rowNotes.push(notes[r][c] || "");
      }
      rows.push({ sku, values: rowValues, notes: rowNotes });
    }

    return { success: true, monthLabel, dates, rows };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
//  WEB APP ENTRY POINT
// ─────────────────────────────────────────────────────────────
function doGet(e) {
  return HtmlService
    .createHtmlOutputFromFile("InventoryForm")
    .setTitle("Travalate Inventory")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─────────────────────────────────────────────────────────────
//  MAIN ENTRY HANDLER  —  called by the web form
// ─────────────────────────────────────────────────────────────
/** Ensures the Transactions sheet has "EditID" (col H) and "Edited" (col I)
 *  headers. Safe to call every time — only adds them if missing, so
 *  existing sheets get upgraded automatically without losing data. */
function ensureTransactionsEditColumns(txSh) {
  const headerRange = txSh.getRange(1, 1, 1, Math.max(txSh.getLastColumn(), 10));
  const headers = headerRange.getValues()[0];
  if (headers[7] !== "EditID") {
    txSh.getRange(1, 8).setValue("EditID");
  }
  if (headers[8] !== "Edited") {
    txSh.getRange(1, 9).setValue("Edited");
  }
  if (headers[9] !== "GroupID") {
    txSh.getRange(1, 10).setValue("GroupID");
  }
}

/** PERFORMANCE: reads only the most recent TRANSACTIONS_TAIL_ROWS data
 *  rows of the Transactions sheet instead of the entire sheet
 *  (getDataRange()). Every caller of this helper only ever needs a
 *  short recent lookback window (3–7 days) — My Entries, Edit Any
 *  Entry, and the Dashboard are all capped server-side to that kind of
 *  range, and edits are only ever allowed on entries that already fall
 *  within one of those windows. Reading the whole sheet for those
 *  lookups gets slower every single day as the sheet grows, since rows
 *  are only ever appended, never removed — this instead bounds the
 *  read to a fixed, small size regardless of how many months of
 *  history have piled up.
 *
 *  Returns { data, startRow } where `data` is a plain array of row
 *  arrays (NO header row included) and `startRow` is the 1-based sheet
 *  row that data[0] corresponds to — use `startRow + localIndex` any
 *  place the code needs a true absolute row number (e.g. building a
 *  "ROW:N" fallback ID), instead of assuming data[0] is row 2.
 */
const TRANSACTIONS_TAIL_ROWS = 8000;
function readRecentTransactionRows_(txSh) {
  const lastRow = txSh.getLastRow();
  const lastCol = Math.max(txSh.getLastColumn(), 10);
  if (lastRow < 2) return { data: [], startRow: 2 };
  const numRows = Math.min(TRANSACTIONS_TAIL_ROWS, lastRow - 1);
  const startRow = lastRow - numRows + 1;
  const data = txSh.getRange(startRow, 1, numRows, lastCol).getValues();
  return { data, startRow };
}

/** Run this ONCE manually from the Script Editor. Backfills a unique
 *  EditID into any existing Transactions row that predates the Edit
 *  Transaction feature (and therefore has a blank EditID). Without
 *  this, those older rows are invisible in "My Entries" / Admin's
 *  "Edit Any Entry" views, since both rely on EditID to identify rows. */
function backfillMissingEditIds() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const txSh = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
  ensureTransactionsEditColumns(txSh);

  const lastRow = txSh.getLastRow();
  if (lastRow < 2) {
    safeAlert("No transaction rows to backfill.");
    return;
  }

  const editIdCol = txSh.getRange(2, 8, lastRow - 1, 1).getValues();
  const editedCol = txSh.getRange(2, 9, lastRow - 1, 1).getValues();

  let filled = 0;
  for (let i = 0; i < editIdCol.length; i++) {
    if (!editIdCol[i][0]) {
      editIdCol[i][0] = Utilities.getUuid();
      filled++;
    }
    if (editedCol[i][0] === "" || editedCol[i][0] === null || editedCol[i][0] === undefined) {
      editedCol[i][0] = false;
    }
  }

  txSh.getRange(2, 8, editIdCol.length, 1).setValues(editIdCol);
  txSh.getRange(2, 9, editedCol.length, 1).setValues(editedCol);

  safeAlert("Backfill complete — " + filled + " existing entries now have an EditID and will appear in 'My Entries' / Admin's 'Edit Any Entry' views.");
}

/** Run this ONCE manually from the Script Editor (after backfillMissingEditIds,
 *  and after deploying the new GroupID column). Backfills a GroupID into
 *  every existing Transactions row that predates the "one form submission
 *  = one group" feature.
 *
 *  Rows from the same original form submission always share the EXACT
 *  same Timestamp (column A) — it's captured once per processInventoryEntry
 *  call and written identically to every row in that batch — so grouping
 *  historical rows by (Timestamp, Employee, Date, Type) safely recreates
 *  the original submission boundaries without needing any new data.
 *
 *  GroupIDs are simple sequential numbers (1, 2, 3…) assigned in
 *  chronological order, so the sheet stays easy to read at a glance —
 *  NOT random UUIDs. Any row that already has a GroupID (e.g. from a
 *  submission made after this feature went live) is left untouched,
 *  and new numbering continues on from whatever the highest existing
 *  GroupID already is, so re-running this safely fills in any gaps
 *  without ever reusing or colliding with a number already in use. */
function backfillMissingGroupIds() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const txSh = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
  ensureTransactionsEditColumns(txSh);

  const lastRow = txSh.getLastRow();
  if (lastRow < 2) {
    safeAlert("No transaction rows to backfill.");
    return;
  }

  // Columns: A=Timestamp, B=Date, C=Employee, D=Type, J=GroupID
  const data = txSh.getRange(2, 1, lastRow - 1, 10).getValues();

  // Find the highest GroupID already in use (numeric ones only — any
  // leftover UUID-style GroupID from before this change is ignored for
  // numbering purposes, but still respected as "already grouped").
  let nextNumber = 1;
  data.forEach(row => {
    const n = Number(row[9]);
    if (row[9] && !isNaN(n) && n >= nextNumber) nextNumber = n + 1;
  });

  // Build groups for ungrouped rows, IN CHRONOLOGICAL ORDER, so GroupID
  // 1 is genuinely your earliest submission, 2 the next, and so on.
  const ungroupedIdxs = [];
  data.forEach((row, i) => { if (!row[9]) ungroupedIdxs.push(i); });
  ungroupedIdxs.sort((a, b) => {
    const ta = data[a][0] instanceof Date ? data[a][0].getTime() : 0;
    const tb = data[b][0] instanceof Date ? data[b][0].getTime() : 0;
    return ta - tb;
  });

  const groupKeyToNumber = {};
  let filled = 0;
  ungroupedIdxs.forEach(i => {
    const row = data[i];
    const ts  = row[0] instanceof Date ? row[0].getTime() : String(row[0]);
    const emp = String(row[2] || "").trim();
    const dt  = row[1] instanceof Date ? row[1].getTime() : String(row[1]);
    const typ = String(row[3] || "").trim();
    const key = ts + "|" + emp + "|" + dt + "|" + typ;

    if (!groupKeyToNumber[key]) {
      groupKeyToNumber[key] = nextNumber;
      nextNumber++;
    }
    row[9] = groupKeyToNumber[key];
    filled++;
  });

  if (filled) {
    txSh.getRange(2, 1, data.length, 10).setValues(data);
  }

  safeAlert("Backfill complete — " + filled + " existing rows now have a sequential GroupID (1, 2, 3…), grouped by their original submission (same timestamp+employee+date+type). 'My Entries' will now show one entry per original form submission instead of one per SKU.");
}

/** Returns the next sequential GroupID (1, 2, 3…) to use for a new form
 *  submission, continuing on from whatever the highest GroupID already
 *  in the sheet is (whether assigned by an earlier live submission or by
 *  backfillMissingGroupIds()). Uses LockService to stay safe even if two
 *  employees submit at almost the exact same moment — without the lock,
 *  both could read the same "current max" and end up with the same
 *  number. */
function getNextGroupId_(txSh) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // up to 10s — generous, since this is just reading one column
  try {
    const lastRow = txSh.getLastRow();
    let maxId = 0;
    if (lastRow >= 2) {
      const groupIdCol = txSh.getRange(2, 10, lastRow - 1, 1).getValues();
      groupIdCol.forEach(row => {
        const n = Number(row[0]);
        if (row[0] && !isNaN(n) && n > maxId) maxId = n;
      });
    }
    return maxId + 1;
  } finally {
    lock.releaseLock();
  }
}

function processInventoryEntry(payload) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const txSh  = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
    const srSh  = getActiveStockSheet();

    // Normalize the type to its SHORT form ("In"/"Out") right here, once,
    // before it's used or stored ANYWHERE downstream. Different callers
    // have historically sent either short ("In"/"Out") or long
    // ("Inward"/"Outward") forms — both were silently ACCEPTED by the
    // comparisons throughout this file, but whatever string came in was
    // also being stored verbatim in the Transactions sheet and in cell
    // notes, which is why some entries showed "(Out)" and others showed
    // "(Outward)"/"(Inward)" depending on which code path created them.
    // Normalizing here guarantees every note, every stored row, and every
    // rebuilt note (which reads the TYPE COLUMN directly) always shows
    // the same short form, regardless of which caller submitted it.
    payload.type = (payload.type === "In" || payload.type === "Inward") ? "In" : "Out";

    const timestamp = new Date();
    const entryDate = new Date(payload.date + "T00:00:00");

    // Server-side future date guard
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    if (entryDate > todayMidnight) {
      return { success: false, error: "Future dates are not allowed." };
    }

    // ── Validate & expand combo SKUs ───────────────────────────
    // Combo entries are Outward-only. Block any combo SKU on an Inward entry.
    // PERFORMANCE: load the Combos sheet ONCE and reuse for every check below
    // instead of re-reading it per SKU line.
    const allCombosForEntry = loadCombos();
    const isOutType = payload.type === "Out";
    for (const item of payload.items) {
      if (isComboSKU(item.sku, allCombosForEntry) && !isOutType) {
        return { success: false, error: "'" + item.sku + "' is a Combo SKU and can only be used for Outward entries." };
      }
    }

    // Expand: each combo line becomes one entry per component SKU (same qty),
    // tagged so the note clearly shows it came from the combo.
    const expandedItems = [];
    payload.items.forEach(item => {
      if (isComboSKU(item.sku, allCombosForEntry)) {
        const components = getComboComponents(item.sku, allCombosForEntry);
        components.forEach(compSku => {
          expandedItems.push({
            sku: compSku,
            qty: item.qty,
            comment: item.comment || "",
            comboSource: item.sku   // tag for note formatting
          });
        });
      } else {
        expandedItems.push(item);
      }
    });

    // ── 1. Batch-write all transaction rows ───────────────────
    // Note: combo-expanded lines are logged against their COMPONENT
    // SKUs in Transactions (so SKU-level history stays accurate),
    // with the combo name appended to the comment for traceability.
    // Columns H (EditID) and I (Edited) support the entry-editing feature:
    //   EditID  = unique ID so a specific row can be found and updated later
    //   Edited  = TRUE once an employee has used their one-time edit
    //   GroupID (J) = shared by every row from THIS form submission, so
    //     "My Entries" can show one entry per submission instead of one
    //     per SKU, and editing one row of a group edits the whole group.
    ensureTransactionsEditColumns(txSh);
    const groupId = getNextGroupId_(txSh);
    const txLastRow = txSh.getLastRow();
    const txRows = expandedItems.map(item => [
      timestamp,
      entryDate,
      payload.employee,
      payload.type,
      item.sku,
      item.qty,
      item.comboSource
        ? (item.comment ? item.comment + " | " : "") + item.comboSource + " (Combo)"
        : (item.comment || ""),
      Utilities.getUuid(),  // EditID
      false,                 // Edited flag
      groupId                 // GroupID — shared across this whole submission
    ]);
    txSh.getRange(txLastRow + 1, 1, txRows.length, 10).setValues(txRows);

    // ── 2. Update Stock Register (fully batched) ──────────────
    updateStockRegister(srSh, entryDate, payload.type, payload.employee, expandedItems);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
//  updateStockRegister()  —  fully batched read/write
// ─────────────────────────────────────────────────────────────
function updateStockRegister(srSh, entryDate, type, employee, items) {

  const dataRange = srSh.getDataRange();
  const data      = dataRange.getValues();
  const notes     = dataRange.getNotes();
  const numRows   = data.length;
  const numCols   = data[0].length;
  const headerRow = data[0];

  // dateColMap: "01-JUN" → col index (0-based)
  const dateColMap = {};
  for (let c = 1; c < numCols; c++) {
    const h = headerRow[c];
    if (!h) continue;
    const key = h instanceof Date ? formatDDMON(h) : String(h).trim().toUpperCase();
    dateColMap[key] = c;
  }

  // skuRowMap: "TR1323 BLACK" → row index (0-based)
  const skuRowMap = {};
  for (let r = 1; r < numRows; r++) {
    const s = String(data[r][0] || "").trim().toUpperCase();
    if (s) skuRowMap[s] = r;
  }

  const targetDateKey = formatDDMON(entryDate).toUpperCase();
  const targetCol     = dateColMap[targetDateKey];
  if (targetCol === undefined) {
    throw new Error("Date column '" + targetDateKey + "' not found in the stock sheet.");
  }

  const allColsSorted = Object.values(dateColMap).sort((a, b) => a - b);
  const targetColPos  = allColsSorted.indexOf(targetCol);
  const prevCol       = targetColPos > 0 ? allColsSorted[targetColPos - 1] : null;

  const ts      = payload_timestamp();
  const qtySign = type === "Inward" || type === "In" ? "+" : "-";

  // Modify data & notes in memory
  items.forEach(item => {
    const skuKey = String(item.sku).trim().toUpperCase();
    const rowIdx = skuRowMap[skuKey];
    if (rowIdx === undefined) return;

    const qty        = Number(item.qty) || 0;
    const currentVal = data[rowIdx][targetCol];
    const isBlank    = currentVal === "" || currentVal === null || currentVal === undefined;

    // IMPORTANT: a cell holding 0 is a REAL value (either from an earlier
    // transaction today that brought stock to exactly zero, or carried
    // forward from a day that ended at zero) — it must be used as-is, NOT
    // treated as "untouched" and silently replaced with yesterday's value.
    // Only a genuinely blank cell (never written) falls back to prevCol.
    let baseStock;
    if (!isBlank) {
      baseStock = Number(currentVal) || 0;
    } else if (prevCol !== null) {
      baseStock = Number(data[rowIdx][prevCol]) || 0;
    } else {
      baseStock = 0;
    }

    const newVal = type === "Inward" || type === "In" ? baseStock + qty : baseStock - qty;
    data[rowIdx][targetCol] = newVal;

    const qtyNote  = qtySign + qty + " (" + type + ")";
    // If this entry came from a combo expansion, show the combo name
    // instead of (or alongside) the manual comment, per spec:
    // "-10 (Out) | TR-Belt-Wallet-Combo"
    const noteTail = item.comboSource
      ? item.comboSource + (item.comment ? " | " + item.comment : "")
      : (item.comment || "");
    const newNote  = ts + " | " + employee + " | " + qtyNote +
                     (noteTail ? " | " + noteTail : "");
    const existing = notes[rowIdx][targetCol] || "";
    notes[rowIdx][targetCol] = existing ? existing + "\n" + newNote : newNote;
  });

  const colDateMap = {};
  Object.entries(dateColMap).forEach(([k, v]) => { colDateMap[v] = k; });
  const futureCols = allColsSorted.slice(targetColPos + 1);

  // ── Cascade forward — ONLY for SKUs in THIS entry ──────────
  // We must not touch any other SKU's future values. Other SKUs were
  // never affected by this submission, and their existing future-date
  // values (whether manually entered or from earlier form entries)
  // must be left exactly as they are.
  const affectedSkuKeys = [...new Set(items.map(item => String(item.sku).trim().toUpperCase()))];

  // PERFORMANCE: most entries are for TODAY — the most recent date column
  // — which means futureCols is empty and there is nothing to cascade.
  // In that case we skip reading the Transactions sheet entirely (it can
  // be huge after months of use). Only a genuinely backdated entry needs
  // the cascade, and even then we only need rows for the SKUs THIS entry
  // touched, not the full transaction history of every SKU.
  if (futureCols.length > 0) {
    const ss     = SpreadsheetApp.getActiveSpreadsheet();
    const txSh   = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
    const txData = txSh.getDataRange().getValues();
    const affectedSkuSet = new Set(affectedSkuKeys);

    const txMap = {};
    for (let r = 1; r < txData.length; r++) {
      const row   = txData[r];
      const txSku = String(row[4] || "").trim().toUpperCase();
      if (!affectedSkuSet.has(txSku)) continue; // skip rows for SKUs not in this entry
      const txDate = row[1];
      if (!txDate) continue;
      const txDateKey = txDate instanceof Date
        ? formatDDMON(txDate).toUpperCase()
        : String(txDate).trim().toUpperCase();
      if (!txDateKey) continue;
      const txType = String(row[3] || "").trim();
      const txQty  = Number(row[5]) || 0;
      const key = txSku + "|" + txDateKey;
      txMap[key] = (txMap[key] || 0) + (txType === "Inward" || txType === "In" ? txQty : -txQty);
    }

    affectedSkuKeys.forEach(skuKey => {
      const rowIdx = skuRowMap[skuKey];
      if (rowIdx === undefined) return;
      let prevStock = Number(data[rowIdx][targetCol]) || 0;
      futureCols.forEach(col => {
        const delta  = txMap[skuKey + "|" + colDateMap[col]] || 0;
        const newVal = prevStock + delta;
        data[rowIdx][col] = newVal;
        prevStock = newVal;
      });
    });
  }

  // ── Recalculate Combo SKU rows = MIN(component stocks) ─────
  // Runs across every affected column (target date + all cascaded future dates)
  // so combo display values always stay in sync with their components.
  const allCombos = loadCombos();
  Object.keys(allCombos).forEach(comboKey => {
    const comboRowIdx = skuRowMap[comboKey];
    if (comboRowIdx === undefined) return; // combo SKU not present as a row — skip

    const componentRowIdxs = allCombos[comboKey]
      .map(c => skuRowMap[String(c).trim().toUpperCase()])
      .filter(idx => idx !== undefined);

    if (!componentRowIdxs.length) return;

    [targetCol, ...futureCols].forEach(col => {
      const compVals = componentRowIdxs.map(idx => Number(data[idx][col]) || 0);
      data[comboRowIdx][col] = Math.min(...compVals);
    });
  });

  // ── Determine which ROWS actually changed ───────────────────
  // Only the SKU(s) in this entry, plus any combo rows recalculated
  // above, were modified. Writing the full sheet height on every
  // entry is wasted work — we narrow to just the affected rows.
  const affectedRowIdxs = new Set();
  affectedSkuKeys.forEach(skuKey => {
    const rowIdx = skuRowMap[skuKey];
    if (rowIdx !== undefined) affectedRowIdxs.add(rowIdx);
  });
  Object.keys(allCombos).forEach(comboKey => {
    const comboRowIdx = skuRowMap[comboKey];
    if (comboRowIdx !== undefined) affectedRowIdxs.add(comboRowIdx);
  });
  const sortedRowIdxs = [...affectedRowIdxs].sort((a, b) => a - b);

  // Build colour grids and write once — ONLY for affected rows & columns
  const affectedCols = [targetCol, ...futureCols];
  const firstAffCol  = affectedCols[0];
  const lastAffCol   = affectedCols[affectedCols.length - 1];
  const affColCount  = lastAffCol - firstAffCol + 1;

  // Group contiguous row blocks so we can write in as few calls as possible
  // while skipping untouched rows in between (common case: 1 row = 1 write)
  sortedRowIdxs.forEach(rowIdx => {
    const bgRow = [], fgRow = [], valRow = [], noteRow = [];
    for (let c = firstAffCol; c <= lastAffCol; c++) {
      const v = Number(data[rowIdx][c]);
      const blank = data[rowIdx][c] === "" || data[rowIdx][c] === null || data[rowIdx][c] === undefined;
      bgRow.push(blank  ? null : v < CONFIG.LOW_STOCK_THRESHOLD ? "#FF0000" : "#FFFFFF");
      fgRow.push(blank  ? null : v < CONFIG.LOW_STOCK_THRESHOLD ? "#FFFFFF" : "#000000");
      valRow.push(data[rowIdx][c]);
      noteRow.push(notes[rowIdx][c] || "");
    }
    const sheetRow = rowIdx + 1; // convert 0-based data-array index to 1-based sheet row
    const rowRange = srSh.getRange(sheetRow, firstAffCol + 1, 1, affColCount);
    rowRange.setValues([valRow]);
    rowRange.setBackgrounds([bgRow]);
    rowRange.setFontColors([fgRow]);
    rowRange.setNotes([noteRow]);
  });
}

// ─────────────────────────────────────────────────────────────
//  WEEKLY REPORTS  —  Sat-Fri window, sent Saturday morning
//  Two reports:
//    1. Top Favorite Products by total Out (Sales) qty
//    2. Top Favorite Products by total In (Received) qty
//  Both also generated on-demand for ANY date range via the
//  form's "Reports" button (downloadable, not just emailed).
// ─────────────────────────────────────────────────────────────

/** Returns the most recent Sat→Fri window ending YESTERDAY (Friday)
 *  when run on a Saturday morning. */
function getLastWeekRange() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Find most recent Friday (could be today if today IS Friday, but
  // this function is meant to run Saturday morning, so "yesterday".
  const dayOfWeek = today.getDay(); // 0=Sun, 6=Sat
  // Days back to last Friday (5)
  let daysSinceFriday = (dayOfWeek - 5 + 7) % 7;
  if (daysSinceFriday === 0) daysSinceFriday = 7; // if today IS Friday, go back a full week
  const friday = new Date(today);
  friday.setDate(friday.getDate() - daysSinceFriday);
  const saturday = new Date(friday);
  saturday.setDate(saturday.getDate() - 6);
  return { start: saturday, end: friday };
}

/** Core report builder: scans Transactions between start/end (inclusive),
 *  sums Out and In quantities per SKU, restricted to favorite SKUs.
 *  Returns { outRows: [[sku, totalOut]], inRows: [[sku, totalIn]] }
 *  sorted descending by quantity. */
function buildFavoriteProductReport(startDate, endDate, scope) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const txSh = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
  const txData = txSh.getDataRange().getValues();

  // scope: "favorites" (default) → only starred SKUs. "all" → every SKU.
  const restrictToFavorites = scope !== "all";
  const favorites = loadFavorites().map(f => f.toUpperCase());
  const favSet = new Set(favorites);

  // Group by canonical Master_SKU casing (not the raw string in the row)
  // so any pre-existing rows written with mismatched casing — e.g. old
  // "TR-BELT" rows synced from Shipment Manager before that was fixed —
  // still roll up into the same total as "TR-Belt" instead of appearing
  // as a lookalike duplicate SKU in the report.
  const canonicalCase = getSkuCanonicalCaseMap_();

  const start = new Date(startDate); start.setHours(0,0,0,0);
  const end   = new Date(endDate);   end.setHours(23,59,59,999);

  const outTotals = {}; // canonical SKU → total Out qty
  const inTotals  = {}; // canonical SKU → total In qty

  for (let r = 1; r < txData.length; r++) {
    const row = txData[r];
    const txDate = row[1];
    if (!txDate || !(txDate instanceof Date)) continue;
    if (txDate < start || txDate > end) continue;

    const rawSku = String(row[4] || "").trim();
    const skuU   = rawSku.toUpperCase();
    if (restrictToFavorites && !favSet.has(skuU)) continue;

    // Fall back to the raw string only if it's no longer a valid
    // Master_SKU entry at all (e.g. renamed/removed since), so nothing
    // silently disappears from the report.
    const sku = canonicalCase[skuU] || rawSku;

    const type = String(row[3] || "").trim();
    const qty  = Number(row[5]) || 0;

    if (type === "Out" || type === "Outward") {
      outTotals[sku] = (outTotals[sku] || 0) + qty;
    } else if (type === "In" || type === "Inward") {
      inTotals[sku] = (inTotals[sku] || 0) + qty;
    }
  }

  const outRows = Object.entries(outTotals).sort((a, b) => b[1] - a[1]);
  const inRows  = Object.entries(inTotals).sort((a, b) => b[1] - a[1]);

  return { outRows, inRows };
}

/** Builds an HTML email body for a report. */
function buildReportEmailHtml(title, rows, qtyLabel, startDate, endDate) {
  const dateRangeStr = Utilities.formatDate(startDate, Session.getScriptTimeZone(), "dd-MMM-yyyy") +
    " to " + Utilities.formatDate(endDate, Session.getScriptTimeZone(), "dd-MMM-yyyy");

  let rowsHtml = "";
  if (!rows.length) {
    rowsHtml = '<tr><td colspan="3" style="padding:14px;text-align:center;color:#888;">No data for this period.</td></tr>';
  } else {
    rows.forEach((r, i) => {
      rowsHtml += `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;">${i + 1}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;font-weight:600;">${r[0]}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;text-align:right;">${r[1]}</td>
      </tr>`;
    });
  }

  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:linear-gradient(135deg,#1a73e8,#0d47a1);color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;font-size:1.25rem;">${title}</h2>
      <p style="margin:6px 0 0;opacity:.85;font-size:.875rem;">${dateRangeStr}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee;border-top:none;">
      <thead>
        <tr style="background:#f5f7fa;">
          <th style="padding:10px 14px;text-align:left;font-size:.75rem;color:#888;">#</th>
          <th style="padding:10px 14px;text-align:left;font-size:.75rem;color:#888;">SKU</th>
          <th style="padding:10px 14px;text-align:right;font-size:.75rem;color:#888;">${qtyLabel}</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p style="font-size:.75rem;color:#aaa;margin-top:14px;text-align:center;">
      Travalate Inventory — Automated Weekly Report
    </p>
  </div>`;
}

/** TRIGGERED weekly (Saturday morning). Builds and emails both reports
 *  for the most recent Sat→Fri window to all REPORT_EMAILS. */
function sendWeeklyFavoriteReport() {
  const { start, end } = getLastWeekRange();
  const { outRows, inRows } = buildFavoriteProductReport(start, end);

  const dateRangeStr = Utilities.formatDate(start, Session.getScriptTimeZone(), "dd-MMM") +
    " to " + Utilities.formatDate(end, Session.getScriptTimeZone(), "dd-MMM-yyyy");

  const outHtml = buildReportEmailHtml("⭐ Top Favorite Products — Total Sales (Out)", outRows, "Total Sold", start, end);
  const inHtml  = buildReportEmailHtml("⭐ Top Favorite Products — Total Received (In)", inRows, "Total Received", start, end);

  if (REPORT_EMAILS.length) {
    MailApp.sendEmail({
      to: REPORT_EMAILS.join(","),
      subject: "Weekly Sales Report (" + dateRangeStr + ") — Travalate Inventory",
      htmlBody: outHtml
    });
    MailApp.sendEmail({
      to: REPORT_EMAILS.join(","),
      subject: "Weekly Received Report (" + dateRangeStr + ") — Travalate Inventory",
      htmlBody: inHtml
    });
  }
}

/** Run ONCE manually to install the Saturday-morning weekly trigger. */
function installWeeklyReportTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "sendWeeklyFavoriteReport")
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("sendWeeklyFavoriteReport")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SATURDAY)
    .atHour(7)
    .create();

  Logger.log("Weekly report trigger installed! Will run every Saturday at ~7 AM.");
  // getUi() only works when run from within the Sheets UI (e.g. a custom
  // menu); it throws when run directly from the Script Editor's Run
  // button. Wrap in try-catch so the trigger still installs successfully
  // either way — check the Execution Log for confirmation if no popup appears.
  try {
    SpreadsheetApp.getUi().alert("Weekly report trigger installed! Will run every Saturday at ~7 AM.");
  } catch (e) {
    // Running from Script Editor — no UI available, that's fine.
  }
}

/** Called from the form's "Reports" button — generates a report for
 *  ANY custom date range, returned as data for client-side download
 *  (not emailed). reportType: "out" | "in". scope: "favorites" | "all" */
function getCustomRangeReport(startDateStr, endDateStr, reportType, scope) {
  const start = new Date(startDateStr + "T00:00:00");
  const end   = new Date(endDateStr + "T00:00:00");
  const { outRows, inRows } = buildFavoriteProductReport(start, end, scope);
  const rows = reportType === "in" ? inRows : outRows;

  const scopeLabel = scope === "all" ? "All Products" : "Top Favorite Products";
  const typeLabel  = reportType === "in" ? "Total Received" : "Total Sales";

  return {
    success: true,
    title: scopeLabel + " — " + typeLabel,
    dateRange: Utilities.formatDate(start, Session.getScriptTimeZone(), "dd-MMM-yyyy") +
               " to " + Utilities.formatDate(end, Session.getScriptTimeZone(), "dd-MMM-yyyy"),
    rows: rows.map(r => ({ sku: r[0], qty: r[1] }))
  };
}

// ─────────────────────────────────────────────────────────────
//  EDIT TRANSACTION FEATURE
//  - Employees: can edit ONLY entries they made TODAY, ONLY ONCE.
//  - Admin: can edit ANY entry, ANY date, UNLIMITED times.
//  Editing updates the Transactions row AND recalculates that SKU's
//  stock cascade from the entry's date forward to today.
// ─────────────────────────────────────────────────────────────

/** Returns entries made by a specific employee within the last 3 days
 *  (today, -1, -2, -3 = 4 days total), formatted for the "edit my
 *  entry" list. Excludes already-edited entries (one-time-edit rule). */
function getMyTodayEntries(employeeName) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const txSh = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
  ensureTransactionsEditColumns(txSh);
  const { data, startRow } = readRecentTransactionRows_(txSh);

  const today = new Date(); today.setHours(0,0,0,0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 3); // 3 days back
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

  // First pass: collect every matching row, same filters as before.
  const rows = [];
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const txDate = row[1];
    if (!(txDate instanceof Date)) continue;
    const txDateOnly = new Date(txDate.getFullYear(), txDate.getMonth(), txDate.getDate());
    if (txDateOnly < cutoff || txDateOnly >= tomorrow) continue;
    if (String(row[2]).trim() !== employeeName) continue;
    if (row[3] === "Combo Created") continue; // informational rows aren't editable

    // Legacy rows that predate GroupID entirely (shouldn't happen after
    // running backfillMissingGroupIds, but fall back gracefully if some
    // slipped through): treat each as its own one-row group using its
    // EditID/ROW fallback, so nothing is ever silently hidden.
    const editId  = row[7] || ("ROW:" + (startRow + r));
    const edited  = row[8] === true || String(row[8]).toUpperCase() === "TRUE";
    const groupId = row[9] || ("SOLO:" + editId);

    rows.push({
      editId, rowNum: startRow + r, groupId,
      timestampMs: row[0] instanceof Date ? row[0].getTime() : 0,
      date: Utilities.formatDate(txDate, Session.getScriptTimeZone(), "dd-MMM"),
      timestamp: Utilities.formatDate(row[0], Session.getScriptTimeZone(), "HH:mm"),
      type: row[3], sku: row[4], qty: row[5], comment: row[6], edited
    });
  }

  // Second pass: fold rows into one summary object per GroupID.
  const groups = {};
  const order = [];
  rows.forEach(r => {
    if (!groups[r.groupId]) {
      groups[r.groupId] = {
        groupId: r.groupId,
        date: r.date,
        timestamp: r.timestamp,
        timestampMs: r.timestampMs,
        type: r.type,
        edited: r.edited,       // true if ANY row in the group has been edited
        items: []
      };
      order.push(r.groupId);
    }
    const g = groups[r.groupId];
    g.edited = g.edited || r.edited;
    g.items.push({ editId: r.editId, sku: r.sku, qty: r.qty, comment: r.comment });
  });

  const result = order.map(id => {
    const g = groups[id];
    return {
      groupId: g.groupId,
      date: g.date,
      timestamp: g.timestamp,
      type: g.type,
      edited: g.edited,
      itemCount: g.items.length,
      totalQty: g.items.reduce((s, it) => s + (Number(it.qty) || 0), 0),
      items: g.items,
      // Comment shown in the list preview: the first item's comment,
      // since the form currently applies one shared comment to the
      // whole submission anyway.
      comment: g.items[0] ? g.items[0].comment : ""
    };
  });

  // Most recent first
  result.sort((a, b) => groups[b.groupId].timestampMs - groups[a.groupId].timestampMs);
  return result;
}

/** Admin-only: returns ALL entries within a date range, from ALL
 *  employees, with no edit-count restriction. The range is capped
 *  server-side to a maximum 7-day span and cannot extend into the
 *  future, regardless of what the client sends. */
function getAllEntriesForAdmin(adminCode, startDateStr, endDateStr) {
  const adminCheck = verifyAdminCode(adminCode);
  if (!adminCheck.valid) return { success: false, error: "Not authorised. Admin PIN required." };

  // ── Build start/end as plain local midnight Dates, then validate ──
  let start = new Date(startDateStr + "T00:00:00");
  let end   = new Date(endDateStr + "T00:00:00");

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { success: false, error: "Invalid date range." };
  }
  if (start > end) {
    // Swap if entered backwards, rather than erroring
    const tmp = start; start = end; end = tmp;
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (end > today) end = new Date(today); // never allow viewing future dates

  // Enforce max 7-day span (inclusive) — if the requested range is
  // wider, clamp the start date forward to keep only the most recent
  // 7 days up to the requested end date.
  const MAX_SPAN_DAYS = 7;
  const spanMs = end.getTime() - start.getTime();
  const spanDays = Math.round(spanMs / 86400000) + 1; // inclusive day count
  if (spanDays > MAX_SPAN_DAYS) {
    start = new Date(end);
    start.setDate(start.getDate() - (MAX_SPAN_DAYS - 1));
  }

  // Inclusive end-of-day boundary for the comparison below
  const endBoundary = new Date(end);
  endBoundary.setHours(23, 59, 59, 999);

  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const txSh = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
  ensureTransactionsEditColumns(txSh);

  // PERFORMANCE: the fast tail-read only reads the most recent slice of
  // the sheet, so it's only safe when the requested range is actually
  // recent. An admin CAN pick an older historical week via the date
  // pickers (no lower bound is enforced), so fall back to a full-sheet
  // read in that rarer case to guarantee correctness.
  const daysSinceStart = Math.round((today.getTime() - start.getTime()) / 86400000);
  const RECENT_WINDOW_DAYS = 60;
  const { data, startRow } = daysSinceStart <= RECENT_WINDOW_DAYS
    ? readRecentTransactionRows_(txSh)
    : { data: txSh.getDataRange().getValues().slice(1), startRow: 2 };

  const entries = [];
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const txDate = row[1];
    if (!(txDate instanceof Date)) continue;

    // Compare using local-midnight-normalised copies to avoid any
    // time-of-day drift between how dates were written vs. read.
    const txDateOnly = new Date(txDate.getFullYear(), txDate.getMonth(), txDate.getDate());
    if (txDateOnly < start || txDateOnly > endBoundary) continue;
    if (row[3] === "Combo Created") continue;

    // Show the row even if it predates the EditID feature — use the
    // row number as a fallback identifier so legacy entries are never
    // silently hidden from view. (Editing legacy rows without a real
    // EditID still works via editTransaction's row lookup fallback.)
    const editId  = row[7] || ("ROW:" + (startRow + r));
    const groupId = row[9] || ("SOLO:" + editId);

    entries.push({
      editId, groupId, rowNum: startRow + r,
      timestampMs: row[0] instanceof Date ? row[0].getTime() : 0,
      date: Utilities.formatDate(txDate, Session.getScriptTimeZone(), "dd-MMM-yyyy"),
      timestamp: Utilities.formatDate(row[0], Session.getScriptTimeZone(), "HH:mm"),
      employee: row[2], type: row[3], sku: row[4], qty: row[5], comment: row[6]
    });
  }

  // Fold into one summary object per GroupID — same pattern as
  // getMyTodayEntries, just without the per-row "edited" tracking since
  // Admin can edit a group any number of times.
  const groups = {};
  const order = [];
  entries.forEach(e => {
    if (!groups[e.groupId]) {
      groups[e.groupId] = {
        groupId: e.groupId, date: e.date, timestamp: e.timestamp,
        timestampMs: e.timestampMs, employee: e.employee, type: e.type,
        items: []
      };
      order.push(e.groupId);
    }
    groups[e.groupId].items.push({ editId: e.editId, sku: e.sku, qty: e.qty, comment: e.comment });
  });

  const groupedEntries = order.map(id => {
    const g = groups[id];
    return {
      groupId: g.groupId, date: g.date, timestamp: g.timestamp,
      employee: g.employee, type: g.type,
      itemCount: g.items.length,
      totalQty: g.items.reduce((s, it) => s + (Number(it.qty) || 0), 0),
      items: g.items,
      comment: g.items[0] ? g.items[0].comment : ""
    };
  });
  groupedEntries.sort((a, b) => groups[b.groupId].timestampMs - groups[a.groupId].timestampMs);

  return {
    success: true,
    entries: groupedEntries,
    appliedStart: Utilities.formatDate(start, Session.getScriptTimeZone(), "yyyy-MM-dd"),
    appliedEnd: Utilities.formatDate(end, Session.getScriptTimeZone(), "yyyy-MM-dd")
  };
}

/** Core edit function — used by BOTH employee (self, today, once) and
 *  Admin (anyone, any date, unlimited) paths.
 *  params.adminCode present = Admin-initiated edit (bypasses restrictions,
 *  but caller must have already verified Admin PIN via verifyAdminCode). */
function editTransaction(params) {
  /*
    params = {
      editId: "uuid...",
      employeeName: "Harshit",      // person performing the edit (for employee path)
      adminCode: null OR "1234",    // present only for Admin-initiated edits
      newSku: "TR1323 BLACK",
      newQty: 25,
      newType: "Out",               // "In" | "Out"
      newComment: "corrected qty"
    }
  */
  try {
    const ss   = SpreadsheetApp.getActiveSpreadsheet();
    const txSh = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
    ensureTransactionsEditColumns(txSh);
    const data = txSh.getDataRange().getValues();

    const isAdminEdit = !!params.adminCode;
    if (isAdminEdit) {
      const adminCheck = verifyAdminCode(params.adminCode);
      if (!adminCheck.valid) return { success: false, error: "Not authorised. Admin PIN required." };
    }

    // Find the row by EditID — or, for legacy rows that never got a
    // real EditID (shown to the client as "ROW:N"), fall back to the
    // row number directly.
    let rowIdx = -1;
    if (typeof params.editId === "string" && params.editId.startsWith("ROW:")) {
      const targetRowNum = parseInt(params.editId.slice(4), 10);
      rowIdx = targetRowNum - 1; // data[] is 0-based, sheet rows are 1-based
      if (rowIdx < 1 || rowIdx >= data.length) rowIdx = -1;
    } else {
      for (let r = 1; r < data.length; r++) {
        if (data[r][7] === params.editId) { rowIdx = r; break; }
      }
    }
    if (rowIdx === -1) return { success: false, error: "Entry not found. It may have already been modified." };

    // If this legacy row still has no real EditID, assign one now so
    // future lookups (and the one-time-edit flag) work normally.
    if (!data[rowIdx][7]) {
      const newEditId = Utilities.getUuid();
      txSh.getRange(rowIdx + 1, 8).setValue(newEditId);
      data[rowIdx][7] = newEditId;
    }

    const row = data[rowIdx];
    const txDate = row[1];
    const originalEmployee = String(row[2]).trim();
    const originalType = row[3];
    const originalSku  = row[4];
    const originalQty  = Number(row[5]) || 0;
    const alreadyEdited = row[8] === true || String(row[8]).toUpperCase() === "TRUE";

    if (!isAdminEdit) {
      // Employee path: must be their own entry, must be within the last
      // 3 days (today, yesterday, day-before, 3-days-ago = 4 days total),
      // must be unedited.
      if (originalEmployee !== params.employeeName) {
        return { success: false, error: "You can only edit your own entries." };
      }
      const today = new Date(); today.setHours(0,0,0,0);
      const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 3); // 3 days back
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      const txDateOnly = (txDate instanceof Date)
        ? new Date(txDate.getFullYear(), txDate.getMonth(), txDate.getDate())
        : null;
      if (!txDateOnly || txDateOnly < cutoff || txDateOnly >= tomorrow) {
        return { success: false, error: "You can only edit entries made within the last 3 days." };
      }
      if (alreadyEdited) {
        return { success: false, error: "This entry has already been edited once and cannot be edited again." };
      }
      if (originalType === "Combo Created") {
        return { success: false, error: "This entry type cannot be edited." };
      }
    }

    // ── Validate new values ───────────────────────────────────
    const newSku  = String(params.newSku).trim();
    const newQty  = Number(params.newQty) || 0;
    const newType = params.newType === "In" || params.newType === "Inward" ? "In" : "Out";
    const newComment = String(params.newComment || "").trim();

    if (!newSku) return { success: false, error: "SKU is required." };
    if (newQty <= 0) return { success: false, error: "Quantity must be a positive number." };

    // ── Update the Transactions row ───────────────────────────
    txSh.getRange(rowIdx + 1, 4).setValue(newType);    // Type
    txSh.getRange(rowIdx + 1, 5).setValue(newSku);     // SKU
    txSh.getRange(rowIdx + 1, 6).setValue(newQty);     // Qty
    txSh.getRange(rowIdx + 1, 7).setValue(newComment); // Comment
    if (!isAdminEdit) {
      txSh.getRange(rowIdx + 1, 9).setValue(true); // mark Edited (employee path only)
    }

    // ── Recalculate stock cascade ─────────────────────────────
    const srSh = getActiveStockSheet();
    const skusToRecalc = new Set([String(originalSku).trim().toUpperCase(), newSku.toUpperCase()]);

    skusToRecalc.forEach(skuKey => {
      try {
        recalculateSkuCascadeFromDate(srSh, txDate, skuKey);
        // ── Rebuild the cell note for this SKU on the entry's date ──
        // recalculateSkuCascadeFromDate only fixes numeric stock values.
        // Notes are NOT touched by that function, so the old comment
        // remains frozen in the cell after an edit. We rebuild the note
        // here from scratch by re-reading ALL transactions for this
        // SKU/date and assembling the note the same way the original
        // submission would have written it.
        rebuildCellNote(srSh, txSh, txDate, skuKey);
      } catch (e) {
        Logger.log("Post-edit recalc warning for " + skuKey + ": " + e.message);
      }
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Edits an ENTIRE form submission (a "group") at once — every SKU row
 *  that was originally submitted together in one processInventoryEntry()
 *  call. Supports editing existing rows' qty/comment, ADDING new SKU
 *  rows, and REMOVING rows that were originally in the group, in a
 *  single save.
 *
 *  params = {
 *    groupId: "uuid...",
 *    employeeName: "Harshit",      // for employee path
 *    adminCode: null OR "1234",    // present only for Admin-initiated edits
 *    newType: "Out",               // "In" | "Out" — applies to the WHOLE group
 *    items: [ { editId: "uuid" | null, sku, qty, comment } ]
 *           // editId present + matches an existing row  -> update that row
 *           // editId null/missing                        -> new row, appended
 *           // any ORIGINAL row whose editId is NOT in this list -> removed
 *  }
 *
 *  The entire group shares one Edited flag: once any row in the group
 *  has been edited, the WHOLE group is marked edited and cannot be
 *  edited again via the employee path (matches the single-row behavior,
 *  just applied once per group instead of per row). */
function editTransactionGroup(params) {
  try {
    const ss   = SpreadsheetApp.getActiveSpreadsheet();
    const txSh = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
    ensureTransactionsEditColumns(txSh);

    const isAdminEdit = !!params.adminCode;
    if (isAdminEdit) {
      const adminCheck = verifyAdminCode(params.adminCode);
      if (!adminCheck.valid) return { success: false, error: "Not authorised. Admin PIN required." };
    }

    const groupId = params.groupId;
    if (!groupId) return { success: false, error: "Missing groupId." };

    const data = txSh.getDataRange().getValues();

    // Find every existing row belonging to this group (supporting the
    // SOLO:/ROW: fallback identifiers getMyTodayEntries can hand out for
    // legacy rows that have no real GroupID, by matching on EditID
    // instead in that case).
    const isSolo = typeof groupId === "string" && groupId.startsWith("SOLO:");
    const soloEditId = isSolo ? groupId.slice(5) : null;
    const groupIdStr = String(groupId).trim();
    const groupRowIdxs = [];
    for (let r = 1; r < data.length; r++) {
      const rowGroupId = data[r][9];
      const rowEditId  = data[r][7] || ("ROW:" + (r + 1));
      // Normalize to strings so a sequential number (e.g. 17) matches
      // regardless of whether it arrives/was-stored as a JS number or
      // a numeric string — strict === would otherwise silently fail to
      // match a legitimate group.
      if (isSolo ? (rowEditId === soloEditId) : (String(rowGroupId).trim() === groupIdStr)) {
        groupRowIdxs.push(r);
      }
    }
    if (!groupRowIdxs.length) {
      return { success: false, error: "Entry not found. It may have already been modified." };
    }

    // Shared metadata, taken from the first row of the group (every row
    // in a group always shares the same date/employee, by construction).
    const firstRow = data[groupRowIdxs[0]];
    const txDate = firstRow[1];
    const originalEmployee = String(firstRow[2]).trim();
    const alreadyEdited = groupRowIdxs.some(r =>
      data[r][8] === true || String(data[r][8]).toUpperCase() === "TRUE"
    );

    if (!isAdminEdit) {
      if (originalEmployee !== params.employeeName) {
        return { success: false, error: "You can only edit your own entries." };
      }
      const today = new Date(); today.setHours(0,0,0,0);
      const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 3);
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      const txDateOnly = (txDate instanceof Date)
        ? new Date(txDate.getFullYear(), txDate.getMonth(), txDate.getDate())
        : null;
      if (!txDateOnly || txDateOnly < cutoff || txDateOnly >= tomorrow) {
        return { success: false, error: "You can only edit entries made within the last 3 days." };
      }
      if (alreadyEdited) {
        return { success: false, error: "This entry has already been edited once and cannot be edited again." };
      }
    }
    if (String(firstRow[3]) === "Combo Created") {
      return { success: false, error: "This entry type cannot be edited." };
    }

    // ── Validate new items ─────────────────────────────────────
    const newType = params.newType === "In" || params.newType === "Inward" ? "In" : "Out";
    const newItems = (params.items || []).map(it => ({
      editId:  it.editId || null,
      sku:     String(it.sku || "").trim(),
      qty:     Number(it.qty) || 0,
      comment: String(it.comment || "").trim()
    }));
    if (!newItems.length) return { success: false, error: "At least one SKU line is required." };
    for (const it of newItems) {
      if (!it.sku) return { success: false, error: "Every line needs a valid SKU." };
      if (it.qty <= 0) return { success: false, error: "Quantity must be a positive number for: " + it.sku };
    }

    // Track every SKU EVER involved (before and after) so the stock
    // cascade is recalculated correctly for removed SKUs too, not just
    // the ones that still remain after this edit.
    const skusToRecalc = new Set();
    groupRowIdxs.forEach(r => skusToRecalc.add(String(data[r][4]).trim().toUpperCase()));
    newItems.forEach(it => skusToRecalc.add(it.sku.toUpperCase()));

    // ── Apply updates to existing rows, track which ones survive ──
    // PERFORMANCE: one setValues() call per row instead of four separate
    // setValue() calls (Type/SKU/Qty/Comment) — each call is a network
    // round-trip, so this alone cuts the write cost of this step 4x for
    // large groups. For employee edits we also fold the "mark this row
    // as edited" flag (col I) into the SAME write, which lets us drop
    // the separate full-sheet re-read + row-by-row scan that used to run
    // afterwards just to set that flag (see note below).
    const matchedOriginalIdxs = new Set();
    newItems.forEach(it => {
      if (!it.editId) return; // new row, handled below
      const rowIdx = groupRowIdxs.find(r => data[r][7] === it.editId);
      if (rowIdx === undefined) return; // editId given but not found in this group — treat as new below
      matchedOriginalIdxs.add(rowIdx);
      if (isAdminEdit) {
        // Admin edits never flip the Edited flag, so leave column I alone.
        txSh.getRange(rowIdx + 1, 4, 1, 4).setValues([[newType, it.sku, it.qty, it.comment]]);
      } else {
        // Employee edits: also set Edited=true right here for this row.
        // EditID (col H) is carried through unchanged from the original data.
        txSh.getRange(rowIdx + 1, 4, 1, 6)
          .setValues([[newType, it.sku, it.qty, it.comment, data[rowIdx][7], true]]);
      }
    });

    // ── Remove original rows that are no longer in newItems ──────
    // Bottom-up so row indices stay valid as we delete.
    const toDelete = groupRowIdxs.filter(r => !matchedOriginalIdxs.has(r)).sort((a, b) => b - a);
    toDelete.forEach(r => txSh.deleteRow(r + 1));

    // ── Append brand-new rows (items with no matching existing editId) ──
    const newRowsToAppend = newItems.filter(it =>
      !it.editId || !groupRowIdxs.some(r => data[r][7] === it.editId)
    );
    if (newRowsToAppend.length) {
      const appendTimestamp = firstRow[0] instanceof Date ? firstRow[0] : new Date();
      const rowsData = newRowsToAppend.map(it => [
        appendTimestamp, txDate, originalEmployee, newType,
        it.sku, it.qty, it.comment, Utilities.getUuid(), true, groupId
        // Edited=true immediately, since this row is being added AS PART OF an edit
      ]);
      const lastRow = txSh.getLastRow();
      txSh.getRange(lastRow + 1, 1, rowsData.length, 10).setValues(rowsData);
    }

    // NOTE: the group's Edited flag no longer needs a separate full-sheet
    // re-read + scan here — matched rows already had Edited=true written
    // inline above (employee path), and newly-appended rows are inserted
    // with Edited=true already set, so every surviving row in the group
    // is correctly flagged the moment the writes above complete.

    // ── Recalculate stock cascade + cell notes for every SKU touched ──
    // PERFORMANCE: recalculateSkuCascadeFromDate() and rebuildCellNote()
    // each independently re-read the ENTIRE Stock Register and ENTIRE
    // Transactions sheet from scratch. Calling them once per SKU (as
    // before) meant a 10-SKU edit did 40 full-sheet reads, and a 60+ SKU
    // edit did 240+ — this is what made large edits slow. Instead, read
    // both sheets ONCE here, pass the same in-memory data into every
    // call, and let each call update that shared data as it writes so
    // later SKUs (including combos) see the latest values without
    // triggering another round-trip to Sheets.
    const srSh = getActiveStockSheet();
    const sharedCombos = loadCombos();
    const sharedSrData = srSh.getDataRange().getValues();
    const sharedTxData = txSh.getDataRange().getValues();
    skusToRecalc.forEach(skuKey => {
      try {
        recalculateSkuCascadeFromDate(srSh, txDate, skuKey, sharedSrData, sharedTxData, sharedCombos);
        rebuildCellNote(srSh, txSh, txDate, skuKey, sharedSrData, sharedTxData);
      } catch (e) {
        Logger.log("Post-group-edit recalc warning for " + skuKey + ": " + e.message);
      }
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Rebuilds the cell note for a specific SKU on a specific date in
 *  the Stock Register by re-reading all matching Transactions rows
 *  and formatting them the same way the original submission wrote them.
 *  Called after every editTransaction()/editTransactionGroup() to
 *  ensure the note always reflects the latest comment, employee, type
 *  and quantity. */
function rebuildCellNote(srSh, txSh, entryDate, skuKey, preloadedSrData, preloadedTxData) {
  // ── Locate the SKU row and date column in the stock sheet ────
  const srData    = preloadedSrData || srSh.getDataRange().getValues();
  const headerRow = srData[0];
  const numCols   = headerRow.length;

  const dateKey = formatDDMON(entryDate).toUpperCase();
  let targetCol = -1;
  for (let c = 1; c < numCols; c++) {
    const h = headerRow[c];
    const k = h instanceof Date ? formatDDMON(h).toUpperCase() : String(h).trim().toUpperCase();
    if (k === dateKey) { targetCol = c; break; }
  }
  if (targetCol === -1) return; // date not in this sheet

  let rowIdx = -1;
  for (let r = 1; r < srData.length; r++) {
    if (String(srData[r][0] || "").trim().toUpperCase() === skuKey) { rowIdx = r; break; }
  }
  if (rowIdx === -1) return; // SKU not in this sheet

  // ── Read all transactions for this SKU on this date ──────────
  const txData = preloadedTxData || txSh.getDataRange().getValues();
  const fromDate = new Date(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate());
  const toDate   = new Date(fromDate); toDate.setDate(toDate.getDate() + 1);

  const noteLines = [];
  for (let r = 1; r < txData.length; r++) {
    const row = txData[r];
    const txDate = row[1];
    if (!(txDate instanceof Date)) continue;
    const txDateOnly = new Date(txDate.getFullYear(), txDate.getMonth(), txDate.getDate());
    if (txDateOnly < fromDate || txDateOnly >= toDate) continue;
    if (String(row[4] || "").trim().toUpperCase() !== skuKey) continue;
    if (row[3] === "Combo Created") continue;

    const txType    = String(row[3] || "").trim();
    const txQty     = Number(row[5]) || 0;
    const txComment = String(row[6] || "").trim();
    const txEmp     = String(row[2] || "").trim();
    const txTs      = Utilities.formatDate(row[0], Session.getScriptTimeZone(), "dd-MMM HH:mm");
    const qtySign   = txType === "In" || txType === "Inward" ? "+" : "-";
    const qtyNote   = qtySign + txQty + " (" + txType + ")";

    noteLines.push(
      txTs + " | " + txEmp + " | " + qtyNote + (txComment ? " | " + txComment : "")
    );
  }

  // ── Write the rebuilt note back to the cell ───────────────────
  const cell = srSh.getRange(rowIdx + 1, targetCol + 1);
  cell.setNote(noteLines.join("\n"));
}

/** Recalculates a SINGLE SKU's stock values from a given date forward
 *  to the last column, based on the (now-corrected) Transactions sheet.
 *  Used after an edit to fix the cascade without needing a full new
 *  "entry" submission. */
function recalculateSkuCascadeFromDate(srSh, fromDate, skuKey, preloadedSrData, preloadedTxData, preloadedCombos) {
  // PERFORMANCE: callers that need to recalc MANY SKUs in one operation
  // (e.g. editTransactionGroup) can pass in already-fetched sheet data
  // here instead of forcing a fresh full-sheet read on every single call.
  // When data IS passed in, this function also mutates it in place after
  // writing, so the NEXT sku processed in the same batch sees up-to-date
  // values (needed for combo calculations) without another round-trip.
  const data      = preloadedSrData || srSh.getDataRange().getValues();
  const headerRow = data[0];
  const numCols   = headerRow.length;

  const dateColMap = {};
  for (let c = 1; c < numCols; c++) {
    const h = headerRow[c];
    if (!h) continue;
    const key = h instanceof Date ? formatDDMON(h) : String(h).trim().toUpperCase();
    dateColMap[key] = c;
  }

  let rowIdx = -1;
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0] || "").trim().toUpperCase() === skuKey) { rowIdx = r; break; }
  }
  if (rowIdx === -1) return; // SKU not in this sheet (e.g. combo component not stocked here)

  const fromDateKey = formatDDMON(fromDate).toUpperCase();
  const allColsSorted = Object.values(dateColMap).sort((a, b) => a - b);
  const fromColPos = allColsSorted.indexOf(dateColMap[fromDateKey]);
  if (fromColPos === -1) return; // date not in this sheet (different month)

  const fromCol = allColsSorted[fromColPos];
  const prevCol = fromColPos > 0 ? allColsSorted[fromColPos - 1] : null;

  // Build txMap fresh (reflects the just-applied edit)
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const txSh   = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
  const txData = preloadedTxData || txSh.getDataRange().getValues();
  const colDateMap = {};
  Object.entries(dateColMap).forEach(([k, v]) => { colDateMap[v] = k; });

  const txMap = {};
  for (let r = 1; r < txData.length; r++) {
    const row = txData[r];
    const txDate = row[1];
    if (!txDate || !(txDate instanceof Date)) continue;
    const txDateKey = formatDDMON(txDate).toUpperCase();
    const txSku  = String(row[4] || "").trim().toUpperCase();
    if (txSku !== skuKey) continue;
    const txType = String(row[3] || "").trim();
    const txQty  = Number(row[5]) || 0;
    const key = txSku + "|" + txDateKey;
    txMap[key] = (txMap[key] || 0) + (txType === "Inward" || txType === "In" ? txQty : -txQty);
  }

  // Base stock = previous day's value (or 0 if this is the first column)
  let runningStock = prevCol !== null ? Number(data[rowIdx][prevCol]) || 0 : 0;

  const colsToUpdate = allColsSorted.slice(fromColPos);
  const valRow = [], bgRow = [], fgRow = [];
  colsToUpdate.forEach(col => {
    const delta = txMap[skuKey + "|" + colDateMap[col]] || 0;
    runningStock = runningStock + delta;
    valRow.push(runningStock);
    bgRow.push(runningStock < CONFIG.LOW_STOCK_THRESHOLD ? "#FF0000" : "#FFFFFF");
    fgRow.push(runningStock < CONFIG.LOW_STOCK_THRESHOLD ? "#FFFFFF" : "#000000");
  });

  const firstCol = colsToUpdate[0];
  const lastCol  = colsToUpdate[colsToUpdate.length - 1];
  const range = srSh.getRange(rowIdx + 1, firstCol + 1, 1, lastCol - firstCol + 1);
  range.setValues([valRow]);
  range.setBackgrounds([bgRow]);
  range.setFontColors([fgRow]);
  // Mirror the write into the in-memory array so a combo check below
  // (or the NEXT skuKey in a shared batch) sees this SKU's fresh values
  // without needing to re-fetch the sheet.
  colsToUpdate.forEach((col, i) => { data[rowIdx][col] = valRow[i]; });

  // Recalculate any combo that depends on this SKU
  const allCombos = preloadedCombos || loadCombos();
  Object.keys(allCombos).forEach(comboKey => {
    if (!allCombos[comboKey].some(c => c.trim().toUpperCase() === skuKey)) return;
    let comboRowIdx = -1;
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][0] || "").trim().toUpperCase() === comboKey) { comboRowIdx = r; break; }
    }
    if (comboRowIdx === -1) return;
    const componentKeys = allCombos[comboKey].map(c => c.trim().toUpperCase());
    // Reuse the same in-memory `data` (already up to date from the
    // write above) instead of re-reading the whole sheet again.
    const compRowIdxs = componentKeys.map(ck => {
      for (let r = 1; r < data.length; r++) {
        if (String(data[r][0] || "").trim().toUpperCase() === ck) return r;
      }
      return -1;
    }).filter(idx => idx !== -1);
    if (!compRowIdxs.length) return;

    const comboValRow = [];
    colsToUpdate.forEach(col => {
      const compVals = compRowIdxs.map(idx => Number(data[idx][col]) || 0);
      comboValRow.push(Math.min(...compVals));
    });
    const comboRange = srSh.getRange(comboRowIdx + 1, firstCol + 1, 1, lastCol - firstCol + 1);
    comboRange.setValues([comboValRow]);
    colsToUpdate.forEach((col, i) => { data[comboRowIdx][col] = comboValRow[i]; });
  });
}

// ─────────────────────────────────────────────────────────────
//  MONTHLY ROLLOVER  —  runs on 1st of each month at 1:00 AM
//  1. Creates new sheet named e.g. "July-26"
//  2. Copies SKU list from Master_SKU
//  3. First 5 columns = last 5 days of previous month (values + colours
//     + cell notes/comments, so recent history stays fully intact)
//  4. Day 1 of the new month gets ONE column, carrying forward the
//     previous month's last day's value (since the midnight trigger
//     has already passed by the time this runs at 1 AM) — every day
//     AFTER that grows incrementally via the existing daily
//     carryForwardStock() trigger, exactly like every other month,
//     instead of pre-building all ~30 empty columns up front
//  5. Protects the new sheet
//  6. Re-installs itself for next month
// ─────────────────────────────────────────────────────────────
function monthlyRollover() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();

  // ── Names & dates ─────────────────────────────────────────
  const newMonthIdx  = now.getMonth();                          // 0-based, current month
  const newYear      = now.getFullYear();
  const newYY        = String(newYear).slice(-2);
  const newSheetName = MONTHS_LONG[newMonthIdx] + "-" + newYY; // e.g. "July-26"

  // Previous month
  const prevMonthDate = new Date(newYear, newMonthIdx - 1, 1);
  const prevMonthIdx  = prevMonthDate.getMonth();
  const prevYear      = prevMonthDate.getFullYear();
  const prevYY        = String(prevYear).slice(-2);
  const prevSheetName = MONTHS_LONG[prevMonthIdx] + "-" + prevYY; // e.g. "June-26"

  // Last 5 days of previous month
  const daysInPrevMonth = new Date(newYear, newMonthIdx, 0).getDate();
  const last5Days = [];
  for (let d = daysInPrevMonth - 4; d <= daysInPrevMonth; d++) {
    last5Days.push(d); // e.g. [27, 28, 29, 30, 31] for July
  }

  // ONLY today's column (day 1) is created here — matching exactly how
  // June-26 itself grows one day at a time. carryForwardStock() already
  // correctly creates each subsequent day's column on its own daily
  // trigger run, so pre-building all 31 columns up front would just be
  // duplicating work that function already does, and would leave 30
  // empty, uncoloured, un-protected-feeling columns sitting there for
  // the rest of the month before any data ever reaches them.
  const remainingDays = [1];

  // ── Get previous month's sheet ────────────────────────────
  const prevSh = ss.getSheetByName(prevSheetName);
  if (!prevSh) throw new Error("Previous month sheet '" + prevSheetName + "' not found.");

  const prevData    = prevSh.getDataRange().getValues();
  const prevNotes   = prevSh.getDataRange().getNotes(); // same shape as prevData — carried into the new sheet alongside values/colors below
  const prevHeader  = prevData[0];
  const numSkuRows  = prevData.length - 1; // excluding header

  // Build map: "DD-MON" → col index in prevData
  const prevDateColMap = {};
  for (let c = 1; c < prevHeader.length; c++) {
    const h   = prevHeader[c];
    const key = h instanceof Date ? formatDDMON(h) : String(h).trim().toUpperCase();
    prevDateColMap[key] = c;
  }

  // PERFORMANCE: Build SKU → row index lookup ONCE instead of doing a
  // linear scan through prevData for every SKU × day combination below.
  const prevSkuRowMap = {};
  for (let r = 1; r < prevData.length; r++) {
    const s = String(prevData[r][0] || "").trim().toUpperCase();
    if (s) prevSkuRowMap[s] = r;
  }

  // ── Create new sheet ──────────────────────────────────────
  let newSh = ss.getSheetByName(newSheetName);
  if (newSh) {
    // Already exists (manual run?) — clear and rebuild
    newSh.clearContents();
    newSh.clearFormats();
  } else {
    newSh = ss.insertSheet(newSheetName);
  }

  // ── Build header row ──────────────────────────────────────
  // Column A: "SKU"
  // Columns B–F: last 5 days of prev month  e.g. "27-JUN", "28-JUN" … "30-JUN"
  // Columns G onward: all days of new month e.g. "01-JUL", "02-JUL" … "31-JUL"
  const prevMonShort = MONTHS_SHORT[prevMonthIdx];
  const newMonShort  = MONTHS_SHORT[newMonthIdx];

  const headerRow = ["SKU"];
  last5Days.forEach(d => headerRow.push(String(d).padStart(2,"0") + "-" + prevMonShort));
  remainingDays.forEach(d => headerRow.push(String(d).padStart(2,"0") + "-" + newMonShort));

  const totalCols = headerRow.length;

  // ── Load SKUs from Master_SKU ─────────────────────────────
  const masterSh   = ss.getSheetByName(CONFIG.SHEETS.MASTER_SKU);
  const masterVals = masterSh.getRange("A2:A" + masterSh.getLastRow()).getValues();
  const skus       = masterVals.map(r => String(r[0]).trim()).filter(s => s.length > 0);

  // ── Build full data grid in memory ───────────────────────
  // Row 0 = header; rows 1..n = SKU data
  const totalRows  = skus.length + 1;
  const valGrid    = [];
  const bgGrid     = [];
  const fgGrid     = [];
  const noteGrid   = []; // carries June's comments into the same last-5-days cells

  // Header row (no colour, no notes)
  valGrid.push(headerRow);
  bgGrid.push(new Array(totalCols).fill(null));
  fgGrid.push(new Array(totalCols).fill(null));
  noteGrid.push(new Array(totalCols).fill(""));

  // SKU rows
  skus.forEach(sku => {
    const valRow  = [sku];
    const bgRow   = [null];
    const fgRow   = [null];
    const noteRow = [""];

    // ── Last 5 days: pull values, colors, AND notes from previous sheet ──
    let lastPrevDayVal = 0; // captured for carrying forward into day 1 of the new month below
    last5Days.forEach(d => {
      const key    = String(d).padStart(2,"0") + "-" + prevMonShort;
      const prevC  = prevDateColMap[key];
      // Direct O(1) lookup instead of a linear scan through prevData
      let prevVal  = 0;
      let prevNote = "";
      if (prevC !== undefined) {
        const prevR = prevSkuRowMap[sku.toUpperCase()];
        if (prevR !== undefined) {
          prevVal  = Number(prevData[prevR][prevC]) || 0;
          prevNote = prevNotes[prevR][prevC] || "";
        }
      }
      valRow.push(prevVal);
      bgRow.push(prevVal < CONFIG.LOW_STOCK_THRESHOLD ? "#FF0000" : "#FFFFFF");
      fgRow.push(prevVal < CONFIG.LOW_STOCK_THRESHOLD ? "#FFFFFF" : "#000000");
      noteRow.push(prevNote);
      lastPrevDayVal = prevVal; // last5Days is in ascending order, so this ends up being the most recent prior day
    });

    // ── Day 1 of the new month: carry forward the previous month's LAST
    // day's value, exactly as carryForwardStock() would have computed it
    // if it ran right now. This is needed because the daily trigger only
    // fires at midnight — which has already passed by the time this 1 AM
    // rollover runs — so without this, day 1 would sit blank all day,
    // and tomorrow's carry-forward would have no real "yesterday" value
    // to read from. No note is carried into day 1 itself (it has no
    // transactions of its own yet — notes only get added as real entries
    // happen on that date). ──
    remainingDays.forEach(() => {
      valRow.push(lastPrevDayVal);
      bgRow.push(lastPrevDayVal < CONFIG.LOW_STOCK_THRESHOLD ? "#FF0000" : "#FFFFFF");
      fgRow.push(lastPrevDayVal < CONFIG.LOW_STOCK_THRESHOLD ? "#FFFFFF" : "#000000");
      noteRow.push("");
    });

    valGrid.push(valRow);
    bgGrid.push(bgRow);
    fgGrid.push(fgRow);
    noteGrid.push(noteRow);
  });

  // ── Write everything in one batch ────────────────────────
  const fullRange = newSh.getRange(1, 1, totalRows, totalCols);
  fullRange.setValues(valGrid);
  fullRange.setBackgrounds(bgGrid);
  fullRange.setFontColors(fgGrid);
  fullRange.setNotes(noteGrid);

  // ── Style the header row ──────────────────────────────────
  const headerRange = newSh.getRange(1, 1, 1, totalCols);
  headerRange.setFontWeight("bold").setBackground("#1a73e8").setFontColor("#FFFFFF");

  // Freeze header row and SKU column
  newSh.setFrozenRows(1);
  newSh.setFrozenColumns(1);

  // ── Protect the new sheet ─────────────────────────────────
  newSh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  const prot = newSh.protect().setDescription(newSheetName + " – read-only");
  prot.removeEditors(prot.getEditors());
  prot.setWarningOnly(false);

  // ── Re-install this trigger for next month ────────────────
  installMonthlyTrigger();

  Logger.log("Monthly rollover complete: " + newSheetName + " created with " +
             skus.length + " SKUs, " + last5Days.length + " prev-month columns (values+notes carried over), " +
             "day 1 column carried forward — remaining days of the month will be added incrementally by carryForwardStock().");
}

// ─────────────────────────────────────────────────────────────
//  carryForwardStock()  —  daily trigger, fully batched
//  If today's date column doesn't exist yet, it is CREATED
//  automatically (right after yesterday's column) before the
//  carry-forward values are written.
// ─────────────────────────────────────────────────────────────
function carryForwardStock() {
  const srSh      = getActiveStockSheet();
  const dataRange = srSh.getDataRange();
  let   data      = dataRange.getValues();
  let   headerRow = data[0];
  let   numRows   = data.length;

  const today     = new Date();
  const todayKey  = formatDDMON(today).toUpperCase();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yestKey   = formatDDMON(yesterday).toUpperCase();

  let todayCol = -1, yestCol = -1;
  for (let c = 1; c < headerRow.length; c++) {
    const h   = headerRow[c];
    const key = h instanceof Date ? formatDDMON(h).toUpperCase() : String(h).trim().toUpperCase();
    if (key === todayKey) todayCol = c;
    if (key === yestKey)  yestCol  = c;
  }

  // ── Auto-create today's column if it doesn't exist ─────────
  if (todayCol === -1) {
    if (yestCol === -1) {
      // No reference column at all — nothing safe to do, log and exit
      Logger.log("carryForwardStock: neither today's nor yesterday's column found. Skipping.");
      return;
    }
    // Insert a new column right after yesterday's column
    const insertAtCol = yestCol + 2; // 1-based position, right after yesterday
    srSh.insertColumnAfter(yestCol + 1);
    srSh.getRange(1, insertAtCol).setValue(formatDDMON(today)); // header e.g. "19-JUN"
    srSh.getRange(1, insertAtCol).setFontWeight("bold")
        .setBackground("#1a73e8").setFontColor("#FFFFFF");

    // Re-read the sheet since structure changed
    const freshRange = srSh.getDataRange();
    data      = freshRange.getValues();
    headerRow = data[0];
    numRows   = data.length;

    // Recompute column indices (yestCol stays same, todayCol is the new one)
    todayCol = yestCol + 1;
  }

  if (yestCol === -1) {
    Logger.log("carryForwardStock: yesterday's column not found. Skipping.");
    return;
  }

  const valCol = [], bgCol = [], fgCol = [];
  for (let r = 1; r < numRows; r++) {
    if (!data[r][0]) {
      valCol.push([data[r][todayCol]]); bgCol.push([null]); fgCol.push([null]); continue;
    }
    const todayVal = data[r][todayCol];
    // IMPORTANT: only a genuinely blank cell (never written) should be
    // carried forward from yesterday. A real 0 — e.g. from a transaction
    // that already ran today and brought stock to exactly zero — must be
    // left as-is, not overwritten with yesterday's value. (Matches the
    // same fix applied in updateStockRegister().)
    const isBlank  = todayVal === "" || todayVal === null || todayVal === undefined;
    const num      = isBlank ? Number(data[r][yestCol]) || 0 : Number(todayVal);
    valCol.push([isBlank ? num : todayVal]);
    bgCol.push([num < CONFIG.LOW_STOCK_THRESHOLD ? "#FF0000" : "#FFFFFF"]);
    fgCol.push([num < CONFIG.LOW_STOCK_THRESHOLD ? "#FFFFFF" : "#000000"]);
  }

  const colRange = srSh.getRange(2, todayCol + 1, numRows - 1, 1);
  colRange.setValues(valCol);
  colRange.setBackgrounds(bgCol);
  colRange.setFontColors(fgCol);
}

// ─────────────────────────────────────────────────────────────
//  getFormInitData()  —  PERFORMANCE: combines getSKUs() + getEmployees()
//  into ONE server round-trip instead of two separate calls on page load.
// ─────────────────────────────────────────────────────────────
function getFormInitData() {
  return {
    skus: getSKUs(),
    employees: getEmployees()
  };
}

// ─────────────────────────────────────────────────────────────
//  getDashboardData()  —  powers the Dashboard tab's 3 cards:
//    1. Top 5 SKUs by CURRENT stock (latest non-blank value per SKU
//       row in this month's active Stock Register sheet)
//    2. Top 5 SKUs by quantity SHIPPED (Out) in the last 7 days
//    3. Top 5 SKUs by quantity INCOMING (In) in the last 7 days
//  Both (2) and (3) are read from the Transactions sheet, same source
//  as the rest of the reporting functions in this file.
// ─────────────────────────────────────────────────────────────
function getDashboardData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── 1. Current stock — latest non-blank value per SKU row ──
    const srSh = getActiveStockSheet();
    const lastRow = srSh.getLastRow();
    const lastCol = srSh.getLastColumn();
    const currentStockList = [];
    if (lastRow >= 2 && lastCol >= 2) {
      const data = srSh.getRange(2, 1, lastRow - 1, lastCol).getValues();
      data.forEach(row => {
        const sku = String(row[0] || "").trim();
        if (!sku) return;
        let val = null;
        for (let c = row.length - 1; c >= 1; c--) {
          if (row[c] !== "" && row[c] !== null && row[c] !== undefined) {
            val = Number(row[c]) || 0;
            break;
          }
        }
        if (val !== null) currentStockList.push({ sku, qty: val });
      });
    }
    currentStockList.sort((a, b) => b.qty - a.qty);
    const top5CurrentStock = currentStockList.slice(0, 5);

    // ── 2 & 3. Shipped (Out) / Incoming (In) totals, last 7 days ──
    const outTotals = {};
    const inTotals  = {};
    const txSh = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
    if (txSh) {
      const { data: txData } = readRecentTransactionRows_(txSh);
      const cutoff = new Date();
      cutoff.setHours(0, 0, 0, 0);
      cutoff.setDate(cutoff.getDate() - 6); // last 7 days, inclusive of today
      txData.forEach(r => {
        const entryDate = r[1];
        if (!(entryDate instanceof Date)) return;
        const entryDateOnly = new Date(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate());
        if (entryDateOnly < cutoff) return;

        const type = String(r[3] || "").trim();
        const sku  = String(r[4] || "").trim();
        const qty  = Number(r[5]) || 0;
        if (!sku) return;

        if (type === "Out" || type === "Outward") {
          outTotals[sku] = (outTotals[sku] || 0) + qty;
        } else if (type === "In" || type === "Inward") {
          inTotals[sku] = (inTotals[sku] || 0) + qty;
        }
      });
    }
    const toSortedTop5 = obj => Object.keys(obj)
      .map(sku => ({ sku, qty: obj[sku] }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);

    return {
      success: true,
      top5CurrentStock: top5CurrentStock,
      top5Shipped: toSortedTop5(outTotals),
      top5Incoming: toSortedTop5(inTotals)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
//  LIVE STOCK SNAPSHOT — full current-stock-per-SKU pull, exposed to
//  Shipment Manager over doPost (action "getStockSnapshot", same
//  shared-secret channel as sync/reverse/getStock below). Distinct
//  from getDashboardData()'s top5CurrentStock (only 5 rows, for the
//  in-app dashboard tile) and from getInventorySnapshot() (the whole
//  month's day-by-day grid, for this app's own Snapshot tab) — this
//  returns EVERY SKU's single latest value, which is all a live
//  "what's in stock right now" view in another app needs. Same
//  "latest non-blank column wins" logic as getDashboardData() above.
// ─────────────────────────────────────────────────────────────
function getCurrentStockSnapshot() {
  try {
    const srSh = getActiveStockSheet();
    const lastRow = srSh.getLastRow();
    const lastCol = srSh.getLastColumn();
    const now = new Date();
    const monthLabel = MONTHS_LONG[now.getMonth()] + " - " + now.getFullYear();

    const stocks = [];
    if (lastRow >= 2 && lastCol >= 2) {
      const headerRow = srSh.getRange(1, 1, 1, lastCol).getValues()[0];
      const data = srSh.getRange(2, 1, lastRow - 1, lastCol).getValues();
      data.forEach(row => {
        const sku = String(row[0] || "").trim();
        if (!sku) return;
        let val = null, asOfCol = -1;
        for (let c = row.length - 1; c >= 1; c--) {
          if (row[c] !== "" && row[c] !== null && row[c] !== undefined) {
            val = Number(row[c]) || 0;
            asOfCol = c;
            break;
          }
        }
        if (val === null) return;
        const asOfHeader = asOfCol >= 0 ? headerRow[asOfCol] : "";
        const asOf = asOfHeader instanceof Date ? prettifyDateHeader_(formatDDMON(asOfHeader)) : prettifyDateHeader_(asOfHeader);
        stocks.push({ sku, qty: val, asOf, low: val < CONFIG.LOW_STOCK_THRESHOLD });
      });
    }
    stocks.sort((a, b) => a.sku.localeCompare(b.sku));

    return { success: true, monthLabel, updatedAt: now.toISOString(), lowStockThreshold: CONFIG.LOW_STOCK_THRESHOLD, stocks };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
//  getSKUs()
// ─────────────────────────────────────────────────────────────
function getSKUs() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const sh   = ss.getSheetByName(CONFIG.SHEETS.MASTER_SKU);
  const vals = sh.getRange("A2:A" + sh.getLastRow()).getValues();
  return vals.map(r => String(r[0]).trim()).filter(s => s.length > 0);
}

/** Returns a map of UPPERCASE SKU -> exact-case SKU exactly as stored in
 *  Master_SKU. Several code paths (Shipment Manager sync, Adjustments)
 *  only need to MATCH a SKU case-insensitively, but the string they hold
 *  at that point is uppercase. Writing that uppercase string straight
 *  into Transactions/Stock Register creates a lookalike duplicate of the
 *  real SKU (e.g. "TR-BELT" next to "TR-Belt"). Always run a SKU back
 *  through this map immediately before it's written anywhere the user
 *  will see it, so every entry — no matter which path created it —
 *  shows the one true casing from Master_SKU. */
function getSkuCanonicalCaseMap_() {
  const map = {};
  getSKUs().forEach(s => { map[s.trim().toUpperCase()] = s.trim(); });
  return map;
}

// ─────────────────────────────────────────────────────────────
//  getCurrentStock()  —  returns the MOST RECENT known stock value
//  for a given SKU from the active month's stock sheet. Used by the
//  form to show "Stock" next to the SKU/Qty fields when an employee
//  selects a SKU.
//  PERFORMANCE: Uses a cached SKU→row lookup (built once per script
//  execution) plus a single targeted row read — NOT a full-sheet read.
// ─────────────────────────────────────────────────────────────
function getCurrentStock(sku) {
  const srSh   = getActiveStockSheet();
  const skuKey = String(sku).trim().toUpperCase();

  // Read only column A (SKU names) to find the row — much cheaper
  // than reading the full data grid.
  const lastRow = srSh.getLastRow();
  if (lastRow < 2) return null;
  const skuCol = srSh.getRange(2, 1, lastRow - 1, 1).getValues();

  let rowIdx = -1; // 0-based within skuCol
  for (let i = 0; i < skuCol.length; i++) {
    if (String(skuCol[i][0] || "").trim().toUpperCase() === skuKey) { rowIdx = i; break; }
  }
  if (rowIdx === -1) return null;

  const sheetRow  = rowIdx + 2; // convert back to 1-based sheet row
  const lastCol   = srSh.getLastColumn();
  // Read only THIS SKU's row (1 row × all date columns) — not the whole sheet
  const rowValues = srSh.getRange(sheetRow, 2, 1, lastCol - 1).getValues()[0];

  // Walk backward to find the most recent non-blank value
  for (let c = rowValues.length - 1; c >= 0; c--) {
    const v = rowValues[c];
    if (v !== "" && v !== null && v !== undefined) {
      return Number(v) || 0;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
//  addNewSKU()  —  called from the New SKU modal
//  Handles BOTH:
//    type "single" → regular SKU with an opening quantity
//    type "combo"  → combo SKU defined by 2+ component SKUs
//                    (no opening qty — value is always MIN of components)
// ─────────────────────────────────────────────────────────────
function addNewSKU(payload) {
  /*
    SINGLE payload = {
      type: "single",
      skuName:  "TR9999 WHITE",
      qty:      200,
      comment:  "New product added",
      employee: "Harshit",
      date:     "2026-06-18"
    }
    COMBO payload = {
      type: "combo",
      skuName:    "TR-Belt-Wallet-Combo",
      components: ["TR-Wallet-Black", "TR-Belt", "TR-Keychain"],
      comment:    "New combo added",
      employee:   "Harshit",
      date:       "2026-06-18"
    }
  */
  try {
    if (payload.type === "combo") {
      return addNewComboSKU(payload);
    }
    return addNewSingleSKU(payload);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
//  addNewSingleSKU()  —  original single-SKU logic
//  1. Adds SKU to Master_SKU tab
//  2. Adds SKU row to current month's stock sheet with opening qty on today's date
//  3. Logs to Transactions tab
// ─────────────────────────────────────────────────────────────
function addNewSingleSKU(payload) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const masterSh = ss.getSheetByName(CONFIG.SHEETS.MASTER_SKU);
  const txSh     = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
  const srSh     = getActiveStockSheet();

  const skuName   = String(payload.skuName).trim();
  const qty       = Number(payload.qty) || 0;
  const entryDate = new Date(payload.date + "T00:00:00");
  const timestamp = new Date();

  // ── 1. Check for duplicate in Master_SKU ─────────────────
  const masterVals = masterSh.getRange("A1:A" + masterSh.getLastRow()).getValues();
  const existing    = masterVals.map(r => String(r[0]).trim().toUpperCase());
  if (existing.includes(skuName.toUpperCase())) {
    return { success: false, error: "SKU already exists in Master_SKU." };
  }

  // ── 2. Add to Master_SKU ──────────────────────────────────
  masterSh.appendRow([skuName]);

  // ── 3. Add new row to Stock Register ─────────────────────
  const srData    = srSh.getDataRange().getValues();
  const headerRow = srData[0];
  const numCols   = headerRow.length;

  const targetDateKey = formatDDMON(entryDate).toUpperCase();
  let targetCol = -1;
  for (let c = 1; c < numCols; c++) {
    const h   = headerRow[c];
    const key = h instanceof Date ? formatDDMON(h).toUpperCase() : String(h).trim().toUpperCase();
    if (key === targetDateKey) { targetCol = c; break; }
  }
  if (targetCol === -1) {
    return { success: false, error: "Date column '" + targetDateKey + "' not found in stock sheet." };
  }

  const newRow = new Array(numCols).fill("");
  newRow[0] = skuName;
  newRow[targetCol] = qty;

  const newRowIdx = srSh.getLastRow() + 1;
  srSh.getRange(newRowIdx, 1, 1, numCols).setValues([newRow]);

  const qtyCell = srSh.getRange(newRowIdx, targetCol + 1);
  if (qty < CONFIG.LOW_STOCK_THRESHOLD) {
    qtyCell.setBackground("#FF0000").setFontColor("#FFFFFF");
  } else {
    qtyCell.setBackground("#FFFFFF").setFontColor("#000000");
  }

  const note = payload_timestamp() + " | " + payload.employee +
               " | +" + qty + " (New SKU)" +
               (payload.comment ? " | " + payload.comment : "");
  qtyCell.setNote(note);

  // ── 4. Log to Transactions ────────────────────────────────
  ensureTransactionsEditColumns(txSh);
  txSh.appendRow([
    timestamp,
    entryDate,
    payload.employee,
    "In",           // Adding a new SKU is always an Inward entry
    skuName,
    qty,
    payload.comment || "",
    Utilities.getUuid(),
    false
  ]);

  return { success: true };
}

// ─────────────────────────────────────────────────────────────
//  addNewComboSKU()  —  creates a new Combo SKU definition
//  1. Validates all component SKUs exist in Master_SKU
//  2. Adds combo SKU to Master_SKU tab
//  3. Adds a row to the Combos sheet (Combo SKU | Comp1 | Comp2 | ...)
//  4. Adds a row to the current month's stock sheet, value =
//     MIN(component stocks) on today's date, calculated immediately
//  5. Logs an informational entry to Transactions (qty 0, no stock impact)
// ─────────────────────────────────────────────────────────────
function addNewComboSKU(payload) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const masterSh = ss.getSheetByName(CONFIG.SHEETS.MASTER_SKU);
  const txSh     = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
  const srSh     = getActiveStockSheet();
  const combosSh = getOrCreateCombosSheet();

  const skuName    = String(payload.skuName).trim();
  const components = (payload.components || [])
    .map(c => String(c).trim())
    .filter(c => c.length > 0);
  const entryDate  = new Date(payload.date + "T00:00:00");
  const timestamp  = new Date();

  if (components.length < 2) {
    return { success: false, error: "A combo needs at least 2 component SKUs." };
  }

  // ── 1. Check for duplicate combo / SKU name ───────────────
  const masterVals = masterSh.getRange("A1:A" + masterSh.getLastRow()).getValues();
  const existing    = masterVals.map(r => String(r[0]).trim().toUpperCase());
  if (existing.includes(skuName.toUpperCase())) {
    return { success: false, error: "SKU name already exists in Master_SKU." };
  }

  // ── 2. Validate every component SKU exists ────────────────
  const missingComponents = components.filter(c => !existing.includes(c.toUpperCase()));
  if (missingComponents.length) {
    return { success: false, error: "Component SKU(s) not found: " + missingComponents.join(", ") };
  }

  // ── 3. Add combo SKU to Master_SKU ────────────────────────
  masterSh.appendRow([skuName]);

  // ── 4. Add definition row to Combos sheet ─────────────────
  // Pad/extend columns as needed if more components than current header supports
  const combosHeader = combosSh.getRange(1, 1, 1, combosSh.getLastColumn()).getValues()[0];
  const neededCols    = 1 + components.length; // SKU col + N component cols
  if (neededCols > combosHeader.length) {
    for (let c = combosHeader.length + 1; c <= neededCols; c++) {
      combosSh.getRange(1, c).setValue("Component " + (c - 1))
              .setFontWeight("bold").setBackground("#1a73e8").setFontColor("#FFFFFF");
    }
  }
  const comboRow = [skuName, ...components];
  combosSh.getRange(combosSh.getLastRow() + 1, 1, 1, comboRow.length).setValues([comboRow]);

  // ── 5. Add new row to Stock Register, value = MIN(components) ──
  const srData    = srSh.getDataRange().getValues();
  const headerRow = srData[0];
  const numCols   = headerRow.length;

  const targetDateKey = formatDDMON(entryDate).toUpperCase();
  let targetCol = -1;
  for (let c = 1; c < numCols; c++) {
    const h   = headerRow[c];
    const key = h instanceof Date ? formatDDMON(h).toUpperCase() : String(h).trim().toUpperCase();
    if (key === targetDateKey) { targetCol = c; break; }
  }
  if (targetCol === -1) {
    return { success: false, error: "Date column '" + targetDateKey + "' not found in stock sheet." };
  }

  // Find each component's row to read its current stock for today
  const skuRowMap = {};
  for (let r = 1; r < srData.length; r++) {
    const s = String(srData[r][0] || "").trim().toUpperCase();
    if (s) skuRowMap[s] = r;
  }
  const compStocks = components.map(c => {
    const rIdx = skuRowMap[c.toUpperCase()];
    return rIdx !== undefined ? Number(srData[rIdx][targetCol]) || 0 : 0;
  });
  const comboQty = compStocks.length ? Math.min(...compStocks) : 0;

  const newRow = new Array(numCols).fill("");
  newRow[0] = skuName;
  newRow[targetCol] = comboQty;

  const newRowIdx = srSh.getLastRow() + 1;
  srSh.getRange(newRowIdx, 1, 1, numCols).setValues([newRow]);

  const qtyCell = srSh.getRange(newRowIdx, targetCol + 1);
  if (comboQty < CONFIG.LOW_STOCK_THRESHOLD) {
    qtyCell.setBackground("#FF0000").setFontColor("#FFFFFF");
  } else {
    qtyCell.setBackground("#FFFFFF").setFontColor("#000000");
  }

  const note = payload_timestamp() + " | " + payload.employee +
               " | New Combo SKU (= MIN of " + components.join(" + ") + ")" +
               (payload.comment ? " | " + payload.comment : "");
  qtyCell.setNote(note);

  // ── 6. Log informational entry to Transactions (qty 0 — no stock impact) ──
  ensureTransactionsEditColumns(txSh);
  txSh.appendRow([
    timestamp,
    entryDate,
    payload.employee,
    "Combo Created",
    skuName,
    0,
    (payload.comment ? payload.comment + " | " : "") + "Components: " + components.join(", "),
    Utilities.getUuid(),
    false
  ]);

  return { success: true };
}

// ─────────────────────────────────────────────────────────────
//  EMPLOYEE REGISTRY  —  now stored dynamically in the "Employees"
//  sheet (created automatically if missing, seeded with your
//  existing employees on first run).
//
//  Employees sheet layout:
//    Column A: Employee Name
//    Column B: 4-digit PIN
//    Column C: Admin (TRUE/FALSE) — only Admin(s) can add/remove employees
// ─────────────────────────────────────────────────────────────

const DEFAULT_EMPLOYEES_SEED = [
  ["Harshit",   "6769", false],
  ["Gautam",    "2896", false],
  ["Jitendra",  "6281", false],
  ["Karamveer", "7849", false],
  ["Venu",      "2486", false],
  ["Pramil",    "4015", false],
  ["Yogendra",  "5249", false],
];

/** Ensures the Employees sheet exists; creates + seeds it if missing.
 *  The sheet is hidden and protected (read-only, owner-only) the moment
 *  it's created so PINs are never casually visible to employees. */
function getOrCreateEmployeesSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("Employees");
  if (!sh) {
    sh = ss.insertSheet("Employees");
    sh.getRange(1, 1, 1, 3).setValues([["Employee Name", "PIN", "Admin"]]);
    sh.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#FFFFFF");
    sh.setFrozenRows(1);
    if (DEFAULT_EMPLOYEES_SEED.length) {
      sh.getRange(2, 1, DEFAULT_EMPLOYEES_SEED.length, 3).setValues(DEFAULT_EMPLOYEES_SEED);
    }
    hideAndProtectEmployeesSheet(sh);
  }
  return sh;
}

/** Hides the Employees sheet tab and protects it from editing
 *  (only the script owner can edit/view it normally). */
function hideAndProtectEmployeesSheet(sh) {
  sh.hideSheet();
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  const prot = sh.protect().setDescription("Employees – PIN data, owner-only");
  prot.removeEditors(prot.getEditors());
  prot.setWarningOnly(false);
}

/** Run this ONCE manually if your Employees sheet already exists and is
 *  currently visible/unprotected — hides and locks it down immediately. */
function secureEmployeesSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("Employees");
  if (!sh) {
    safeAlert("No 'Employees' sheet found yet — it will be created and secured automatically on first use.");
    return;
  }
  hideAndProtectEmployeesSheet(sh);
  safeAlert("Employees sheet is now hidden and protected. Only you (the owner) can view or edit it (Right-click the sheet tabs \u2192 'Show hidden sheets' to access it).");
}

/** Reads the Employees sheet and returns [{name, code, isAdmin}, ...] */
function loadEmployees() {
  const sh   = getOrCreateEmployeesSheet();
  const data = sh.getDataRange().getValues();
  const list = [];
  for (let r = 1; r < data.length; r++) {
    const name = String(data[r][0] || "").trim();
    if (!name) continue;
    const code    = String(data[r][1] || "").trim();
    const isAdmin = data[r][2] === true || String(data[r][2]).trim().toUpperCase() === "TRUE";
    list.push({ name, code, isAdmin, rowNum: r + 1 }); // rowNum = 1-based sheet row
  }
  return list;
}

function getEmployees() {
  return loadEmployees().map(e => e.name);
}

function verifyEmployeeCode(name, code) {
  const emp = loadEmployees().find(e => e.name === name);
  if (!emp) return { valid: false, message: "Employee not found." };
  if (emp.code !== String(code).trim()) return { valid: false, message: "Incorrect PIN. Please try again." };
  return { valid: true, isAdmin: emp.isAdmin };
}

/** Verifies a PIN belongs to an Admin specifically. Used to gate the
 *  Add/Remove Employee panel. Does NOT reveal which names are admins. */
function verifyAdminCode(code) {
  const emp = loadEmployees().find(e => e.isAdmin && e.code === String(code).trim());
  if (!emp) return { valid: false, message: "Incorrect Admin PIN." };
  return { valid: true, name: emp.name };
}

/** Persistent-login entry point for the topbar/sidebar app shell (mirrors
 *  loginEmployee() in the Shipment Manager). This is separate from
 *  verifyEmployeeCode(), which still gates each individual stock entry —
 *  this app is often used on a shared warehouse PC, so login only drives
 *  the identity shown in the topbar and whether the Admin Panel nav item
 *  is visible; it does NOT bypass the per-entry PIN check. */
function loginEmployeeSession(name, pin) {
  const check = verifyEmployeeCode(name, pin);
  if (!check.valid) return { success: false, message: check.message || "Invalid name or PIN." };
  return { success: true, name: name, isAdmin: !!check.isAdmin };
}

/** Self-service PIN change, callable by any logged-in employee for their
 *  own account. Always requires the CURRENT pin as reauthentication.
 *  newPin may be null/'' if nothing changed (no-op success). */
function updateOwnPin(name, currentPin, newPin) {
  try {
    const check = verifyEmployeeCode(name, currentPin);
    if (!check.valid) return { success: false, message: "Current PIN is incorrect." };
    if (!newPin) return { success: true }; // nothing to change

    const cleanNewPin = String(newPin).trim();
    if (!/^\d{4}$/.test(cleanNewPin)) return { success: false, message: "New PIN must be exactly 4 digits." };

    const employees = loadEmployees();
    const target = employees.find(e => e.name === name);
    if (!target) return { success: false, message: "Account not found. Please log in again." };
    if (employees.some(e => e.name !== name && e.code === cleanNewPin)) {
      return { success: false, message: "This PIN is already in use by another employee. Choose a different one." };
    }

    const sh = getOrCreateEmployeesSheet();
    sh.getRange(target.rowNum, 2).setValue(cleanNewPin);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Admin override: resets ANY employee's PIN. Requires a valid Admin PIN
 *  (re-verified here, not just trusted from the client). Unlike
 *  updateOwnPin(), no current-PIN reauthentication from the target
 *  employee is required — the admin is resetting a forgotten/compromised
 *  PIN, not proving their own identity. */
function resetEmployeePin(adminCode, targetName, newPin) {
  const adminCheck = verifyAdminCode(adminCode);
  if (!adminCheck.valid) return { success: false, error: "Not authorised. Admin PIN required." };

  const cleanNewPin = String(newPin).trim();
  if (!/^\d{4}$/.test(cleanNewPin)) return { success: false, error: "PIN must be exactly 4 digits." };

  const employees = loadEmployees();
  const target = employees.find(e => e.name === targetName);
  if (!target) return { success: false, error: "Employee not found." };
  if (employees.some(e => e.name !== targetName && e.code === cleanNewPin)) {
    return { success: false, error: "This PIN is already in use by another employee. Choose a different one." };
  }

  const sh = getOrCreateEmployeesSheet();
  sh.getRange(target.rowNum, 2).setValue(cleanNewPin);
  return { success: true };
}

/** Adds a new employee. Requires a valid Admin PIN. */
function addEmployee(adminCode, newName, newCode) {
  const adminCheck = verifyAdminCode(adminCode);
  if (!adminCheck.valid) return { success: false, error: "Not authorised. Admin PIN required." };

  const name = String(newName).trim();
  const code = String(newCode).trim();

  if (!name) return { success: false, error: "Employee name is required." };
  if (!/^\d{4}$/.test(code)) return { success: false, error: "PIN must be exactly 4 digits." };

  const employees = loadEmployees();
  if (employees.some(e => e.name.toUpperCase() === name.toUpperCase())) {
    return { success: false, error: "An employee with this name already exists." };
  }
  if (employees.some(e => e.code === code)) {
    return { success: false, error: "This PIN is already in use by another employee. Choose a different one." };
  }

  const sh = getOrCreateEmployeesSheet();
  sh.appendRow([name, code, false]);
  return { success: true };
}

/** Removes an employee by name. Requires a valid Admin PIN.
 *  Prevents removing the last remaining Admin. */
function removeEmployee(adminCode, targetName) {
  const adminCheck = verifyAdminCode(adminCode);
  if (!adminCheck.valid) return { success: false, error: "Not authorised. Admin PIN required." };

  const sh        = getOrCreateEmployeesSheet();
  const employees = loadEmployees();
  const target     = employees.find(e => e.name === targetName);
  if (!target) return { success: false, error: "Employee not found." };

  if (target.isAdmin) {
    const adminCount = employees.filter(e => e.isAdmin).length;
    if (adminCount <= 1) {
      return { success: false, error: "Cannot remove the only Admin. Promote another employee to Admin first." };
    }
  }

  sh.deleteRow(target.rowNum);
  return { success: true };
}

/** Returns the list of NON-ADMIN employee names only (for the admin
 *  panel's employee list + remove-employee dropdown). Admin(s) are
 *  excluded so the panel only manages regular employees, and PINs
 *  are never sent to the client. */
function getEmployeeNamesForAdmin(adminCode) {
  const adminCheck = verifyAdminCode(adminCode);
  if (!adminCheck.valid) return { success: false, error: "Not authorised. Admin PIN required." };
  const names = loadEmployees()
    .filter(e => !e.isAdmin)
    .map(e => e.name);
  return { success: true, names: names };
}

/** PERFORMANCE: Combines employee names + favorites + the default
 *  7-day entries list into ONE server round-trip, instead of firing
 *  3 separate google.script.run calls when the Admin panel unlocks. */
function getAdminPanelInitData(adminCode) {
  const adminCheck = verifyAdminCode(adminCode);
  if (!adminCheck.valid) return { success: false, error: "Not authorised. Admin PIN required." };

  // NOTE: this used to also fetch a 7-day Transactions window for the
  // "Edit Any Entry" section that lived inline in the Admin Panel. That
  // section is now its own tab (see initEditAnyEntryTab_ / client-side
  // showTab('editany')), which fetches its own data on demand — so this
  // no longer needs to touch the Transactions sheet at all, making
  // Admin Panel load close to instant.
  const employeeNames = loadEmployees().filter(e => !e.isAdmin).map(e => e.name);
  const favorites = loadFavorites();

  return {
    success: true,
    employeeNames,
    favorites
  };
}

/** Run this ONCE manually from the Script Editor to make an employee
 *  an Admin. Change the name below before running. */
function makeEmployeeAdmin() {
  const NAME_TO_PROMOTE = "Harshit"; // <-- change this to the employee you want as Admin

  const sh   = getOrCreateEmployeesSheet();
  const data = sh.getDataRange().getValues();
  let found = false;
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]).trim().toUpperCase() === NAME_TO_PROMOTE.toUpperCase()) {
      sh.getRange(r + 1, 3).setValue(true);
      found = true;
      break;
    }
  }
  if (found) {
    safeAlert(NAME_TO_PROMOTE + " is now an Admin.");
  } else {
    safeAlert("Employee '" + NAME_TO_PROMOTE + "' not found in the Employees sheet.");
  }
}

// ─────────────────────────────────────────────────────────────
//  SETUP HELPERS  —  run once from Script Editor
// ─────────────────────────────────────────────────────────────
function initialiseFromOpeningStock() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const osSh = ss.getSheetByName(CONFIG.SHEETS.OPENING_STOCK);
  const srSh = getActiveStockSheet();

  const osData    = osSh.getDataRange().getValues();
  const srData    = srSh.getDataRange().getValues();
  const headerRow = srData[0];

  let col14 = -1;
  for (let c = 1; c < headerRow.length; c++) {
    const h   = headerRow[c];
    const key = h instanceof Date ? formatDDMON(h).toUpperCase() : String(h).trim().toUpperCase();
    if (key === "14-JUN") { col14 = c; break; }
  }
  if (col14 === -1) throw new Error("Column '14-JUN' not found in stock sheet.");

  const skuRowMap = {};
  for (let r = 1; r < srData.length; r++) {
    const s = String(srData[r][0] || "").trim().toUpperCase();
    if (s) skuRowMap[s] = r;
  }

  const numDataRows = srData.length - 1;
  const valCol = srData.slice(1).map(r => [r[col14]]);
  const bgCol  = srData.slice(1).map(() => [null]);
  const fgCol  = srData.slice(1).map(() => [null]);

  for (let r = 1; r < osData.length; r++) {
    const sku = String(osData[r][0] || "").trim().toUpperCase();
    const qty = Number(osData[r][1]) || 0;
    if (!sku) continue;
    const rowIdx = skuRowMap[sku];
    if (rowIdx === undefined) continue;
    valCol[rowIdx - 1] = [qty];
    bgCol[rowIdx - 1]  = [qty < CONFIG.LOW_STOCK_THRESHOLD ? "#FF0000" : "#FFFFFF"];
    fgCol[rowIdx - 1]  = [qty < CONFIG.LOW_STOCK_THRESHOLD ? "#FFFFFF" : "#000000"];
  }

  const writeRange = srSh.getRange(2, col14 + 1, numDataRows, 1);
  writeRange.setValues(valCol);
  writeRange.setBackgrounds(bgCol);
  writeRange.setFontColors(fgCol);

  safeAlert("Opening stock for 14-JUN written successfully!");
}

/** Run once — installs the daily carry-forward trigger */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "carryForwardStock")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("carryForwardStock").timeBased().atHour(0).everyDays(1).create();
  safeAlert("Daily carry-forward trigger installed!");
}

/** Run once — installs the monthly rollover trigger (1st of each month, 1 AM) */
function installMonthlyTrigger() {
  // Remove any existing monthly trigger to avoid duplicates
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "monthlyRollover")
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Schedule for 1st of next month at 01:00
  const now       = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 1, 0, 0);

  ScriptApp.newTrigger("monthlyRollover")
    .timeBased()
    .at(nextMonth)
    .create();

  Logger.log("Monthly trigger set for: " + nextMonth.toDateString());
  // Only show alert if called directly (not from monthlyRollover itself)
  try {
    safeAlert(
      "Monthly rollover trigger installed!\nWill run automatically on: " +
      nextMonth.toDateString() + " at 1:00 AM"
    );
  } catch(e) { /* called from trigger context — no UI available, that's fine */ }
}

/** Protect whichever month's sheet is currently active */
function protectStockRegister() {
  const srSh = getActiveStockSheet();
  srSh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  const prot = srSh.protect().setDescription(srSh.getName() + " – read-only");
  prot.removeEditors(prot.getEditors());
  prot.setWarningOnly(false);
  safeAlert(srSh.getName() + " is now protected (read-only for non-owners).");
}

/** Run this manually any time you suspect a date column is missing.
 *  Safe to run multiple times — does nothing if today's column already exists. */
function fixMissingTodayColumn() {
  carryForwardStock();
  safeAlert("Checked and fixed today's column (if it was missing).");
}

/** Run this manually after adding a new Combo SKU row, or any time you
 *  want to force-recalculate ALL combo SKU values across ALL date columns
 *  in the current month's sheet (combo value = MIN of its components). */
function recalcAllCombos() {
  const srSh      = getActiveStockSheet();
  const dataRange = srSh.getDataRange();
  const data      = dataRange.getValues();
  const numRows   = data.length;
  const numCols   = data[0].length;
  const headerRow = data[0];

  const skuRowMap = {};
  for (let r = 1; r < numRows; r++) {
    const s = String(data[r][0] || "").trim().toUpperCase();
    if (s) skuRowMap[s] = r;
  }

  const allCombos = loadCombos();
  Object.keys(allCombos).forEach(comboKey => {
    const comboRowIdx = skuRowMap[comboKey];
    if (comboRowIdx === undefined) return;
    const componentRowIdxs = allCombos[comboKey]
      .map(c => skuRowMap[String(c).trim().toUpperCase()])
      .filter(idx => idx !== undefined);
    if (!componentRowIdxs.length) return;

    for (let c = 1; c < numCols; c++) {
      const compVals = componentRowIdxs.map(idx => Number(data[idx][c]) || 0);
      data[comboRowIdx][c] = Math.min(...compVals);
    }
  });

  // Write back values + recompute colours for the whole sheet in one go
  const bgGrid = [], fgGrid = [];
  for (let r = 1; r < numRows; r++) {
    const bgRow = [], fgRow = [];
    for (let c = 1; c < numCols; c++) {
      const v = Number(data[r][c]);
      const blank = data[r][c] === "" || data[r][c] === null || data[r][c] === undefined;
      bgRow.push(blank ? null : v < CONFIG.LOW_STOCK_THRESHOLD ? "#FF0000" : "#FFFFFF");
      fgRow.push(blank ? null : v < CONFIG.LOW_STOCK_THRESHOLD ? "#FFFFFF" : "#000000");
    }
    bgGrid.push(bgRow); fgGrid.push(fgRow);
  }

  const fullRange = srSh.getRange(2, 2, numRows - 1, numCols - 1);
  const valGrid   = data.slice(1).map(row => row.slice(1));
  fullRange.setValues(valGrid);
  fullRange.setBackgrounds(bgGrid);
  fullRange.setFontColors(fgGrid);

  safeAlert("All Combo SKU values recalculated across the full sheet.");
}

// ─────────────────────────────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────────────────────────────
/** Shows a UI alert if possible; silently logs instead if running
 *  outside the Sheets UI context (e.g. directly from the Script
 *  Editor's Run button, or from a time-based trigger). Use this
 *  instead of calling SpreadsheetApp.getUi().alert(...) directly
 *  in any "run once" setup function, since getUi() throws when
 *  there's no UI context available. */
function safeAlert(message) {
  Logger.log(message);
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    // No UI context available — message is already in the Execution Log.
  }
}

function formatDDMON(date) {
  return String(date.getDate()).padStart(2,"0") + "-" + MONTHS_SHORT[date.getMonth()];
}

function payload_timestamp() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd-MMM HH:mm");
}

// ============================================================
//  SHIPMENT MANAGER INTEGRATION
//  ------------------------------------------------------------
//  Lets the separate "Shipment Manager" Apps Script project push
//  stock deductions into this Inventory sheet whenever a PO/
//  shipment is created, edited, or deleted over there.
//
//  Communication: Shipment Manager calls THIS script's deployed
//  Web App URL (doPost) with a JSON body. We never call out to
//  Shipment Manager — all traffic is one-directional, inbound.
//
//  Idempotency: every shipment has a unique ID (generated by
//  Shipment Manager). We keep our own ledger — Shipment_Sync_Log —
//  of exactly how much of each SKU we've deducted for that ID.
//  On every sync call we diff "what should be deducted now" against
//  "what the ledger says we already deducted", and only apply the
//  difference. This makes edits (qty changed, SKU added/removed)
//  and deletes (qty -> 0) safe to call any number of times without
//  ever double-counting.
// ============================================================

const SHIPMENT_SYNC = {
  SHEET: "Shipment_Sync_Log",
  // Shared secret — must match SHARED_SECRET in the Shipment Manager
  // script. Change this to your own value in BOTH places.
  SHARED_SECRET: "Tr4v4l4t9e-2056-xaya9pL",
};

/** Columns: SHIPMENT_ID | SKU | QTY | UPDATED_TS */
function getOrCreateShipmentSyncSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHIPMENT_SYNC.SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHIPMENT_SYNC.SHEET);
    sh.getRange(1, 1, 1, 4).setValues([["SHIPMENT_ID", "SKU", "QTY", "UPDATED_TS"]]);
    sh.getRange(1, 1, 1, 4).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#FFFFFF");
    sh.setFrozenRows(1);
    sh.hideSheet();
  }
  return sh;
}

/** Reads the current ledger rows for one shipment ID.
 *  Returns { sku: qty, ... } using UPPERCASE sku keys. */
function getLedgerForShipment_(shipmentId) {
  const sh = getOrCreateShipmentSyncSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return {};
  const data = sh.getRange(2, 1, lastRow - 1, 3).getValues();
  const map = {};
  data.forEach(r => {
    if (String(r[0]) === String(shipmentId)) {
      const sku = String(r[1] || "").trim().toUpperCase();
      if (sku) map[sku] = (map[sku] || 0) + (Number(r[2]) || 0);
    }
  });
  return map;
}

/** Replaces all ledger rows for a shipment ID with a fresh set.
 *  (Simplest correct approach: delete old rows for this ID, append new ones.) */
function rewriteLedgerForShipment_(shipmentId, skuQtyMap) {
  const sh = getOrCreateShipmentSyncSheet_();
  const lastRow = sh.getLastRow();

  // Remove existing rows for this shipment ID (scan bottom-up so deleteRow is safe)
  if (lastRow >= 2) {
    const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]) === String(shipmentId)) {
        sh.deleteRow(i + 2);
      }
    }
  }

  const ts = new Date();
  const newRows = Object.keys(skuQtyMap)
    .filter(sku => skuQtyMap[sku] !== 0)
    .map(sku => [shipmentId, sku, skuQtyMap[sku], ts]);

  if (newRows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, 4).setValues(newRows);
  }
}

/** Core sync function. Pass the FULL desired state for a shipment —
 *  i.e. every SKU + qty that should currently be deducted for it.
 *  On a delete, pass an empty desiredSkuQtyMap ({}).
 *
 *  desiredSkuQtyMap = { "TR1323 BLACK": 12, "TR9981 RED": 4 }
 *  entryDate        = "YYYY-MM-DD" (the PO/shipment date — must have
 *                      a matching column in the active month's stock
 *                      sheet, same rule as the manual entry form)
 *  employeeName     = string, used for the cell-note audit trail
 *  comment          = string shown in the cell note tail, e.g.
 *                      "BLINKIT - BENGALURU  (49990010044810)" — matches
 *                      the existing manual-entry note style:
 *                      23-Jun 10:36 | Karamveer | -100 (Out) | BLINKIT - BENGALURU  (49990010044810)
 *
 *  Returns { success, applied: [...], skipped: [...] }
 */
function syncShipmentToInventory(shipmentId, desiredSkuQtyMap, entryDate, employeeName, comment) {
  try {
    if (!shipmentId) return { success: false, error: "Missing shipmentId." };

    // PERFORMANCE: read Master_SKU ONCE per call and reuse everywhere
    // below, instead of re-reading the whole sheet twice.
    const masterSkuList = getSKUs();
    const masterSkuSet = new Set(masterSkuList.map(s => s.trim().toUpperCase()));
    // UPPERCASE key -> exact Master_SKU casing, so anything ultimately
    // written to Transactions/Stock Register always matches the SKU as
    // it actually appears in Master_SKU (see getSkuCanonicalCaseMap_).
    const canonicalCase = {};
    masterSkuList.forEach(s => { canonicalCase[s.trim().toUpperCase()] = s.trim(); });

    // ── Expand any combo SKU into its component SKUs FIRST ──────
    // A combo SKU (e.g. "TR-BELT-WALLET-COMBO") is a valid Master_SKU
    // entry, so it would otherwise pass the masterSkuSet check below —
    // but processInventoryEntry() rejects combo SKUs outright on Inward
    // entries (combos are Outward-only by design; Inward stock must
    // always be added back to the REAL components, not the combo name
    // itself). Without this expansion, reversing a shipment containing
    // a combo SKU (e.g. on delete) would always fail here, since a
    // reversal is exactly the kind of Inward entry that rule blocks.
    // Expanding here — for BOTH directions, not just Inward — also
    // keeps this consistent with how Inventory's own Transactions log
    // already records combo entries against their component SKUs, not
    // the combo name, and keeps the diff/ledger logic below operating
    // on real components throughout instead of mixing combo names in.
    const allCombosForSync = loadCombos();
    const expandedQtyMap = {};
    Object.keys(desiredSkuQtyMap || {}).forEach(sku => {
      const qty = Number(desiredSkuQtyMap[sku]) || 0;
      if (isComboSKU(sku, allCombosForSync)) {
        getComboComponents(sku, allCombosForSync).forEach(compSku => {
          expandedQtyMap[compSku] = (expandedQtyMap[compSku] || 0) + qty;
        });
      } else {
        expandedQtyMap[sku] = (expandedQtyMap[sku] || 0) + qty;
      }
    });

    const desired = {};
    Object.keys(expandedQtyMap).forEach(sku => {
      const key = String(sku).trim().toUpperCase();
      if (!key) return;
      desired[key] = (desired[key] || 0) + (Number(expandedQtyMap[sku]) || 0);
    });

    const existing = getLedgerForShipment_(shipmentId);

    // Diff: for every SKU touched (in either set), compute the delta
    // between what's desired now and what we already applied before.
    const allSkus = new Set([...Object.keys(desired), ...Object.keys(existing)]);
    const deltas = []; // { sku, qty } — qty can be negative (means add back / reduce outward)
    allSkus.forEach(sku => {
      const want = desired[sku] || 0;
      const have = existing[sku] || 0;
      const delta = want - have; // positive => need to deduct MORE outward; negative => need to give back
      if (delta !== 0) deltas.push({ sku, qty: delta });
    });

    const applied = [];
    const skipped = [];
    const noteComment = comment || ("Shipment " + shipmentId);

    if (deltas.length) {
      // Split into two processInventoryEntry calls: positive deltas are
      // additional Outward deductions, negative deltas are Inward
      // reversals (giving stock back) of the same magnitude. Both use
      // the SAME comment text — updateStockRegister() already prefixes
      // the qty/sign/type (e.g. "-100 (Out)"), so the comment itself
      // should just be "PLATFORM - CITY  (PO NUMBER)" either way.
      const outwardItems = deltas.filter(d => d.qty > 0).map(d => ({ sku: d.sku, qty: d.qty, comment: noteComment }));
      const inwardItems  = deltas.filter(d => d.qty < 0).map(d => ({ sku: d.sku, qty: -d.qty, comment: noteComment }));

      const validOutward = outwardItems.filter(i => masterSkuSet.has(i.sku))
        .map(i => ({ ...i, sku: canonicalCase[i.sku] || i.sku }));
      const validInward  = inwardItems.filter(i => masterSkuSet.has(i.sku))
        .map(i => ({ ...i, sku: canonicalCase[i.sku] || i.sku }));
      outwardItems.filter(i => !masterSkuSet.has(i.sku)).forEach(i => skipped.push(i.sku));
      inwardItems.filter(i => !masterSkuSet.has(i.sku)).forEach(i => skipped.push(i.sku));

      if (validOutward.length) {
        const res = processInventoryEntry({
          date: entryDate,
          type: "Outward",
          employee: employeeName || "Shipment Manager",
          items: validOutward
        });
        if (!res.success) return { success: false, error: "Outward sync failed: " + res.error };
        validOutward.forEach(i => applied.push({ sku: i.sku, qty: i.qty, direction: "out" }));
      }
      if (validInward.length) {
        const res = processInventoryEntry({
          date: entryDate,
          type: "Inward",
          employee: employeeName || "Shipment Manager",
          items: validInward
        });
        if (!res.success) return { success: false, error: "Inward (reversal) sync failed: " + res.error };
        validInward.forEach(i => applied.push({ sku: i.sku, qty: i.qty, direction: "in" }));
      }
    }

    // Ledger now reflects the new desired state exactly (only for SKUs
    // that were actually valid Master_SKU entries — unmapped/invalid
    // SKUs are never recorded so they get retried on the next sync).
    const newLedgerState = {};
    Object.keys(desired).forEach(sku => {
      if (masterSkuSet.has(sku)) newLedgerState[sku] = desired[sku];
    });
    rewriteLedgerForShipment_(shipmentId, newLedgerState);

    return { success: true, applied, skipped };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Convenience wrapper: fully reverses (zeroes out) a shipment's
 *  inventory impact. Used when a shipment is deleted. */
function reverseShipmentFromInventory(shipmentId, entryDate, employeeName, comment) {
  return syncShipmentToInventory(shipmentId, {}, entryDate, employeeName, comment);
}

/** Adjustment Block support (called by Shipment Manager's Adjustment
 *  feature). Pushes a standalone Inward stock-in for a shortage
 *  discovered AFTER the original shipment was already synced — e.g.
 *  100 units were originally deducted, but only 80 actually shipped,
 *  so 20 need to come back.
 *
 *  Deliberately NOT the same code path as syncShipmentToInventory: this
 *  is a one-off additive movement, not a re-sync of the shipment's full
 *  desired state, so it does NOT touch Shipment_Sync_Log at all. If it
 *  did, the ledger would then read as "only 80 units currently
 *  deducted for this shipment" — and the next time the ORIGINAL
 *  shipment is genuinely edited (it still shows 100 packed, since
 *  Shipment Manager never changes its own boxes for an adjustment) the
 *  diff logic in syncShipmentToInventory would try to deduct the
 *  missing 20 all over again. Keeping this off-ledger avoids that.
 *
 *  itemsQtyMap = { "TR1323 BLACK": 20 } — POSITIVE qty means "add this
 *  many units back" (an Inward movement), same shape as the sync
 *  action's `items` payload.
 *
 *  Returns { success, applied: [...], skipped: [...] } */
function applyShipmentAdjustmentToInventory(shipmentId, itemsQtyMap, entryDate, employeeName, comment) {
  try {
    if (!shipmentId) return { success: false, error: "Missing shipmentId." };
    if (!itemsQtyMap || !Object.keys(itemsQtyMap).length) {
      return { success: true, applied: [], skipped: [] };
    }

    // Same canonical-case restoration as syncShipmentToInventory: match
    // case-insensitively, but always write the real Master_SKU casing.
    const canonicalCase = getSkuCanonicalCaseMap_();
    const masterSkuSet = new Set(Object.keys(canonicalCase));

    // Same combo-expansion rule as syncShipmentToInventory above: a
    // combo SKU can't itself take an Inward entry (processInventoryEntry
    // rejects that outright), so expand into real components FIRST.
    const allCombosForAdj = loadCombos();
    const expandedQtyMap = {};
    Object.keys(itemsQtyMap).forEach(sku => {
      const qty = Number(itemsQtyMap[sku]) || 0;
      if (qty <= 0) return;
      if (isComboSKU(sku, allCombosForAdj)) {
        getComboComponents(sku, allCombosForAdj).forEach(compSku => {
          expandedQtyMap[compSku] = (expandedQtyMap[compSku] || 0) + qty;
        });
      } else {
        expandedQtyMap[sku] = (expandedQtyMap[sku] || 0) + qty;
      }
    });

    const noteComment = comment || ("Shipment " + shipmentId + " Adjustment");
    const items = [];
    const skipped = [];
    Object.keys(expandedQtyMap).forEach(sku => {
      const key = String(sku).trim().toUpperCase();
      if (masterSkuSet.has(key)) {
        items.push({ sku: canonicalCase[key], qty: expandedQtyMap[sku], comment: noteComment });
      } else {
        skipped.push(sku);
      }
    });

    if (!items.length) return { success: true, applied: [], skipped };

    // Single Inward entry for everything — updateStockRegister() (called
    // inside processInventoryEntry) prefixes the timestamp/employee/sign
    // itself, e.g. "07-Jul 11:35 | Karamveer | +20 (In) | <comment>",
    // matching the existing manual-entry note style exactly.
    const res = processInventoryEntry({
      date: entryDate,
      type: "Inward",
      employee: employeeName || "Shipment Manager",
      items: items
    });
    if (!res.success) return { success: false, error: "Adjustment Inward failed: " + res.error };

    return { success: true, applied: items.map(i => ({ sku: i.sku, qty: i.qty, direction: "in" })), skipped };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Returns the full Master_SKU list — used by Shipment Manager to
 *  power the "map this SKU to an Inventory SKU" dropdown when an
 *  employee enters a Shipment Manager SKU that has no mapping yet. */
function getInventorySkuListForMapping() {
  return getSKUs();
}

// ── WEB APP ENTRY POINT FOR CROSS-PROJECT CALLS ───────────────
// Shipment Manager calls this URL (your /exec deployment URL) via
// UrlFetchApp.fetch() with a JSON POST body shaped like:
//   {
//     secret: "...",                  // must match SHARED_SECRET above
//     action: "sync" | "reverse" | "adjustmentIn" | "getSkuList" | "getStock",
//     shipmentId: "S171234...",       // required for sync/reverse/adjustmentIn
//     date: "2026-06-23",             // required for sync/reverse/adjustmentIn
//     employee: "Pramil",             // optional, for audit notes
//     comment: "BLINKIT - BENGALURU  (49990010044810)", // optional, cell-note tail
//     items: { "TR1323 BLACK": 12 },  // required for "sync"/"adjustmentIn"
//     sku: "TR1323 BLACK"             // required for "getStock" only
//   }
//
// NOTE: doPost only handles THIS integration. The existing doGet()
// (the manual entry form) is untouched and keeps working as before.
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: "Invalid JSON body." }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (body.secret !== SHIPMENT_SYNC.SHARED_SECRET) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: "Unauthorized." }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  let result;
  try {
    if (body.action === "sync") {
      result = syncShipmentToInventory(body.shipmentId, body.items || {}, body.date, body.employee, body.comment);
    } else if (body.action === "reverse") {
      result = reverseShipmentFromInventory(body.shipmentId, body.date, body.employee, body.comment);
    } else if (body.action === "adjustmentIn") {
      result = applyShipmentAdjustmentToInventory(body.shipmentId, body.items || {}, body.date, body.employee, body.comment);
    } else if (body.action === "getSkuList") {
      result = { success: true, skus: getInventorySkuListForMapping() };
    } else if (body.action === "getStock") {
      const stock = getCurrentStock(body.sku);
      result = { success: true, stock: stock === null ? null : stock };
    } else if (body.action === "getStockSnapshot") {
      result = getCurrentStockSnapshot();
    } else {
      result = { success: false, error: "Unknown action: " + body.action };
    }
  } catch (err) {
    result = { success: false, error: err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════