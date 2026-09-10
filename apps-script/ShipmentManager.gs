// ============================================================
// SHIPMENT MANAGER - Apps Script
// Blinkit / Swiggy / Zepto Box Entry System
// Admins: Pramil (4015), Venu (2486)
// ============================================================

// ── SHEET NAMES ──────────────────────────────────────────────
const SHEET_SKU       = "SKU_MASTER";   // INVENTORY_SKU | SKU | AMAZON_SKU | AMAZON | BLINKIT | SWIGGY | ZEPTO | WEIGHT_PER_UNIT
const SHEET_EMPLOYEES = "EMPLOYEES";    // NAME | PIN | ROLE | STATUS | MODULES
const SHEET_LOG       = "SHIPMENT_LOG"; // flat audit trail of all submitted line items
const SHEET_SHIPMENTS = "SHIPMENTS";    // structured shipment records (one row per shipment)
const SHEET_WAREHOUSES = "BLINKIT_WAREHOUSES"; // NAME | ADDRESS | GST_NUMBER — Blinkit only
const SHEET_RO_SETTINGS = "RO_SETTINGS";       // single-row settings: seller + consignee details, reused on every RO Invoice
const SHEET_RO_INVOICES = "RO_INVOICES";       // one row per shipment that has had an RO Invoice created — enforces "one ever" + unique invoice numbers
const SHEET_CANCELLED_INVOICES = "CANCELLED_INVOICE_NUMBERS"; // permanent record of every invoice number that's ever been superseded (Edit RO) or voided (shipment deleted) — never reusable, on any shipment, ever again
const SHEET_BLINKIT_PO  = "BLINKIT_PO";        // PO_NUMBER|WAREHOUSE|UPLOAD_DATE|EXPIRY_DATE|UPLOADED_BY|ITEM_CODE|UPC|DESCRIPTION|MRP|LANDING_RATE|GST_PCT|PO_QTY|SHIPPED_QTY|STATUS
const SHEET_ZEPTO_PO    = "ZEPTO_PO";          // same 14-column layout as BLINKIT_PO — see PO_PLATFORM_CONFIG below
const SHEET_SWIGGY_PO   = "SWIGGY_PO";         // same 14-column layout as BLINKIT_PO/ZEPTO_PO — see PO_PLATFORM_CONFIG below
const SHEET_SNAPSHOT     = "INVENTORY_SNAPSHOT_LOG"; // flat per-day per-warehouse per-SKU stock log — DATE|WAREHOUSE|ITEM_ID|ITEM_NAME|TOTAL_SELLABLE|UPLOADED_AT|UPLOADED_BY
const SHEET_SNAPSHOT_RAW = "SNAPSHOT_BACKFILL_RAW";  // admin pastes historical wide-format data here once; backfillSnapshotFromRawSheet() consumes it
const SHEET_SNAPSHOT_DISABLED = "SNAPSHOT_DISABLED_ENTITIES"; // TYPE (WAREHOUSE|SKU) | VALUE | DISABLED_AT | DISABLED_BY — hides an entity from the Snapshot grid/search until re-enabled
const SHEET_SNAPSHOT_QTY = "SNAPSHOT_QTY_VALUES"; // WAREHOUSE | ITEM_ID | COL | VALUE | UPDATED_AT | UPDATED_BY — persists the two "Qty to ship" columns typed into the Blinkit Shipment Planning grid (ITEM_ID is "__WH__" for the freeform cells on the warehouse-name bar itself)
const SNAPSHOT_RETENTION_DAYS = 31; // rolling window — writeSnapshotRows_ prunes anything older than the most recent N distinct dates

// ── MODULE DEFINITIONS ────────────────────────────────────────
// Canonical module IDs and their display names. These are stored as a
// comma-separated list in the MODULES column of EMPLOYEES. Admins
// always have access to everything; Finance and Viewer are restricted
// to their assigned modules; Employee gets a sensible default below.
// Keep in sync with MODULE_DEFS in ShipmentManagerIndex.html.
const ALL_MODULES = [
  { id: "SHIPMENT_CREATION",    label: "New Shipment (Complete Form)" },
  { id: "SKU_MASTER",           label: "SKU Master" },
  { id: "SKU_MASTER_DELETE",    label: "Delete" },            // secondary — nested under SKU Master
  { id: "SHIPMENTS_VIEW",       label: "Shipments (Complete)" },
  { id: "SHIPMENT_BOX_DETAILS", label: "Box Details & JPG" }, // secondary — nested under Shipments
  { id: "SHIPMENT_LABELS",      label: "Labels & PDF" },      // secondary — nested under Shipments
  { id: "SHIPMENT_EDIT",        label: "Edit" },              // secondary — nested under Shipments
  { id: "SHIPMENT_BALANCE",     label: "Balance" },           // secondary — nested under Shipments
  { id: "SHIPMENT_POD",         label: "Upload POD" },        // secondary — nested under Shipments
  { id: "SHIPMENT_ADJUST",      label: "Adjustment" },        // secondary — nested under Shipments
  { id: "RO_INVOICE",           label: "RO Invoice" },        // secondary — nested under Shipments
  { id: "TALLY_EXCEL",          label: "Tally Excel" },       // secondary — nested under Shipments
  { id: "RO_EWAYBILL",          label: "E-way Bill / DP" },   // secondary — nested under Shipments
  { id: "RO_EDIT",              label: "Edit RO" },           // secondary — nested under Shipments
  { id: "SHIPMENT_DELETE",      label: "Delete Shipment" },   // secondary — nested under Shipments
  { id: "WAREHOUSES",           label: "Warehouses" },
  { id: "INVENTORY_SNAPSHOT",   label: "Blinkit Shipment Planning" },
  { id: "EXTENDED_SESSION_TIMEOUT", label: "Extended Logout Timing (Admin-style)" }
];
const ALL_MODULE_IDS = ALL_MODULES.map(m => m.id);

// ── VALID ROLES ───────────────────────────────────────────────
const VALID_ROLES = ["admin", "employee", "finance", "viewer"];

// ── TRAVALATE INVENTORY INTEGRATION ───────────────────────────
// Set INVENTORY_WEBAPP_URL to your Travalate Inventory script's
// deployed /exec Web App URL. INVENTORY_SHARED_SECRET must match
// SHIPMENT_SYNC.SHARED_SECRET in the Inventory script exactly.
const INVENTORY_WEBAPP_URL    = "https://script.google.com/macros/s/AKfycbwyU5NATMoqY3La_piZ7XG34HohF5qhKsxJwUDOHdYOFdSBShtBmmIqrPJBgTvxhXx9/exec";
const INVENTORY_SHARED_SECRET = "Tr4v4l4t9e-2056-xaya9pL";

// ── WEB APP ENTRY POINT ──────────────────────────────────────
function doGet(e) {
  const page = e.parameter.page || "login";
  const template = HtmlService.createTemplateFromFile("Index");
  template.page = page;
  return template.evaluate()
    .setTitle("Travalate Shipment Manager")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── AUTH ──────────────────────────────────────────────────────
/** Powers the "Unlock Editing" control on the pre-login public Blinkit
 *  Shipment Planning view (see unlockSnapshotPublicEditing_ in the
 *  HTML). Deliberately PIN-only, no name required — same quick-auth
 *  convention already used for the admin-only Snapshot actions
 *  (Backfill, Clear Log, etc. all just check "does this PIN match
 *  someone authorized", not name+PIN together). Matches against every
 *  enabled employee (not just admins), since a regular employee who
 *  has been granted the INVENTORY_SNAPSHOT module should also be able
 *  to unlock editing here, not only admins. Returns the matched
 *  person's name so the UI can show who unlocked it, without ever
 *  logging them into a full session — this never touches currentUser,
 *  it only flips a client-side edit-lock flag for that browser tab. */
function verifySnapshotEditPin(pin) {
  try {
    const trimmedPin = String(pin || "").trim();
    if (!trimmedPin) return { success: false, message: "Enter a PIN." };
    const employees = getEmployees();
    const match = employees.find(function (e) {
      if (e.status === "disabled") return false;
      if (String(e.pin || "").trim() !== trimmedPin) return false;
      if (e.role === "admin") return true;
      const modules = e.modules ? e.modules.split(",").map(function (s) { return s.trim(); }) : [];
      return modules.indexOf("INVENTORY_SNAPSHOT") !== -1;
    });
    if (!match) return { success: false, message: "Incorrect PIN, or this PIN isn't authorized to edit Blinkit Shipment Planning." };
    return { success: true, name: match.name };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Shared by loginEmployee (after a PIN match) and getEmployeeSession
 *  (refreshing an already-authenticated browser session on reload, no
 *  PIN involved) — one place deriving the {role, modules} shape from
 *  an EMPLOYEES row, so the two paths can never drift apart. */
function deriveSessionFromEmployeeRow_(row) {
  const rawRole    = (row[2] || "employee").toString().trim().toLowerCase();
  const status     = (row[3] || "enabled").toString().trim().toLowerCase();
  const modulesRaw = (row[4] || "").toString().trim();
  if (status === "disabled") {
    return { success: false, message: "Your account has been disabled. Please contact an admin." };
  }
  const role = VALID_ROLES.includes(rawRole) ? rawRole : "employee";
  // Admins always get all modules; others get exactly what's assigned.
  const modules = role === "admin"
    ? ALL_MODULE_IDS
    : modulesRaw ? modulesRaw.split(",").map(s=>s.trim()).filter(Boolean)
                 : (role === "employee" ? ["SHIPMENT_CREATION", "SHIPMENTS_VIEW", "SHIPMENT_EDIT"] : []);
  return { success: true, name: row[0], role, status, modules };
}

function loginEmployee(name, pin) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_EMPLOYEES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_EMPLOYEES);
    sheet.appendRow(["NAME", "PIN", "ROLE", "STATUS", "MODULES"]);
  }

  // PERFORMANCE: read EMPLOYEES once and reuse it both to ensure at
  // least one admin exists AND to check the login credentials, instead
  // of two separate full-sheet reads (this used to happen on every
  // single login attempt).
  //
  // This is a lockout safety net ONLY — it seeds Pramil/Venu the very
  // first time this sheet is ever used (when it has zero admins at
  // all), so whoever deploys the app always has a way in. It must NOT
  // assume any specific name or PIN has to keep existing forever: an
  // earlier version checked for the literal name "pramil", which broke
  // when that account was renamed; a later version checked for the
  // literal PIN "4015", which broke the same way when that PIN was
  // changed too (to 4012) as part of the same rename. Checking "is
  // there at least one admin row, period" is the only version of this
  // that survives an admin freely renaming themselves AND changing
  // their PIN, while still protecting against a genuinely empty sheet.
  let data = sheet.getDataRange().getValues();
  const hasAnyAdmin = data.slice(1).some(r => (r[2] || "").toString().trim().toLowerCase() === "admin");
  if (!hasAnyAdmin) {
    sheet.appendRow(["Pramil", "4015", "admin", "enabled", ""]);
    sheet.appendRow(["Venu",   "2486", "admin", "enabled", ""]);
    data = sheet.getDataRange().getValues(); // only re-read if we actually added rows
  }

  const nameLower = name.trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim().toLowerCase() === nameLower &&
        data[i][1].toString().trim() === pin.toString().trim()) {
      return deriveSessionFromEmployeeRow_(data[i]);
    }
  }
  return { success: false, message: "Invalid name or PIN." };
}

/** Refreshes an ALREADY-authenticated session after a page reload — no
 *  PIN involved, since the person already proved who they are at
 *  original login; this only re-derives their current role/modules and
 *  confirms they're still enabled. Called from restoreSessionIfAny_ in
 *  the HTML (see there for why sessionStorage/refresh doesn't need a
 *  fresh PIN) — never used to authenticate someone for the first time,
 *  and callers must not treat a bare name match here as proof of
 *  identity the way a successful loginEmployee() call is. */
function getEmployeeSession(name) {
  const sheet = ensureEmployeesSheet_();
  const data = sheet.getDataRange().getValues();
  const nameLower = (name || "").toString().trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim().toLowerCase() === nameLower) {
      return deriveSessionFromEmployeeRow_(data[i]);
    }
  }
  return { success: false, message: "Account not found." };
}

// ── EMPLOYEE MANAGEMENT (admin only) ─────────────────────────
function ensureEmployeesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_EMPLOYEES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_EMPLOYEES);
    sheet.appendRow(["NAME", "PIN", "ROLE", "STATUS", "MODULES"]);
  } else {
    // Migrate: ensure STATUS and MODULES columns exist on older sheets.
    const hdr = sheet.getRange(1, 1, 1, Math.max(5, sheet.getLastColumn())).getValues()[0];
    if ((hdr[3] || "").toString().trim().toUpperCase() !== "STATUS")  sheet.getRange(1, 4).setValue("STATUS");
    if ((hdr[4] || "").toString().trim().toUpperCase() !== "MODULES") sheet.getRange(1, 5).setValue("MODULES");
  }
  return sheet;
}

function getEmployees() {
  const sheet = ensureEmployeesSheet_();
  const data = sheet.getDataRange().getValues();
  return data.slice(1).map(r => ({
    name:    (r[0] || "").toString(),
    pin:     (r[1] || "").toString(),
    role:    (r[2] || "employee").toString().trim().toLowerCase(),
    status:  (r[3] || "enabled").toString().trim().toLowerCase() || "enabled",
    modules: (r[4] || "").toString().trim()
  }));
}

function addEmployee(name, pin, role, modules, requesterName, requesterRole) {
  if (!isRequesterAdmin_(requesterName)) {
    return { success: false, message: "You do not have permission to add employees." };
  }
  const sheet = ensureEmployeesSheet_();
  const safeRole = VALID_ROLES.includes((role||"").toLowerCase()) ? role.toLowerCase() : "employee";
  const safeMods = (modules || "").toString().trim();
  sheet.appendRow([name.trim(), pin.toString().trim(), safeRole, "enabled", safeMods]);
  return { success: true };
}

/** Update an existing employee's role, module assignments, and/or PIN.
 *  Admin-only — enforced here now, not just hidden client-side.
 *  Unlike updateOwnProfile(), this is an ADMIN OVERRIDE — no current-PIN
 *  reauthentication is required, since the admin is resetting someone
 *  else's forgotten/compromised PIN, not proving their own identity. */
function updateEmployee(name, updates, requesterName, requesterRole) {
  try {
    if (!isRequesterAdmin_(requesterName)) {
      return { success: false, message: "You do not have permission to update employees." };
    }
    const sheet = ensureEmployeesSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString().trim().toLowerCase() === (name||"").trim().toLowerCase()) {
        if (updates.role    !== undefined) {
          const safeRole = VALID_ROLES.includes((updates.role||"").toLowerCase()) ? updates.role.toLowerCase() : "employee";
          sheet.getRange(i + 1, 3).setValue(safeRole);
        }
        if (updates.modules !== undefined) sheet.getRange(i + 1, 5).setValue((updates.modules||"").toString().trim());
        if (updates.pin) {
          const cleanPin = updates.pin.toString().trim();
          if (!/^\d{4,6}$/.test(cleanPin)) return { success: false, message: "PIN must be 4–6 digits." };
          sheet.getRange(i + 1, 2).setValue(cleanPin);
        }
        return { success: true };
      }
    }
    return { success: false, message: "Employee not found." };
  } catch (err) { return { success: false, message: err.message }; }
}

/** Self-service profile update, callable by ANY logged-in employee for
 *  their own account (unlike updateEmployee(), which is admin-only and
 *  only touches role/modules). Always requires the CURRENT pin as
 *  reauthentication, whether only the name, only the PIN, or both are
 *  being changed — the PIN is this app's sole auth factor, so any
 *  change to the account needs it re-proven.
 *
 *  currentName: the name the employee is currently logged in as.
 *  currentPin:  required, must match what's on file.
 *  newName:     required, the (possibly unchanged) name to save.
 *  newPin:      optional — pass null/'' to keep the existing PIN. */
function updateOwnProfile(currentName, currentPin, newName, newPin) {
  try {
    const sheet = ensureEmployeesSheet_();
    const data = sheet.getDataRange().getValues();
    const curNameLower = (currentName || "").trim().toLowerCase();
    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString().trim().toLowerCase() === curNameLower) { rowIdx = i; break; }
    }
    if (rowIdx === -1) return { success: false, message: "Account not found. Please log in again." };

    const storedPin = data[rowIdx][1].toString().trim();
    if (storedPin !== (currentPin || "").toString().trim()) {
      return { success: false, message: "Current PIN is incorrect." };
    }

    const cleanNewName = (newName || "").toString().trim();
    if (!cleanNewName) return { success: false, message: "Name cannot be empty." };

    // If renaming, make sure no OTHER employee already has that name.
    if (cleanNewName.toLowerCase() !== curNameLower) {
      for (let i = 1; i < data.length; i++) {
        if (i !== rowIdx && data[i][0].toString().trim().toLowerCase() === cleanNewName.toLowerCase()) {
          return { success: false, message: "Another employee already has that name." };
        }
      }
    }

    if (newPin) {
      const cleanNewPin = newPin.toString().trim();
      if (!/^\d{4,6}$/.test(cleanNewPin)) {
        return { success: false, message: "New PIN must be 4–6 digits." };
      }
      sheet.getRange(rowIdx + 1, 2).setValue(cleanNewPin);
    }
    sheet.getRange(rowIdx + 1, 1).setValue(cleanNewName);

    return { success: true, name: cleanNewName };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Enable or disable an employee account. Admins cannot be disabled. */
function toggleEmployeeStatus(name, newStatus, requesterName, requesterRole) {
  try {
    if (!isRequesterAdmin_(requesterName)) {
      return { success: false, message: "You do not have permission to enable/disable employees." };
    }
    const sheet = ensureEmployeesSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0].toString().trim().toLowerCase() === (name||"").trim().toLowerCase()) {
        const role = (data[i][2] || "").toString().trim().toLowerCase();
        if (role === "admin" && newStatus === "disabled") {
          return { success: false, message: "Admin accounts cannot be disabled." };
        }
        sheet.getRange(i + 1, 4).setValue(newStatus === "disabled" ? "disabled" : "enabled");
        return { success: true };
      }
    }
    return { success: false, message: "Employee not found." };
  } catch (err) { return { success: false, message: err.message }; }
}

function deleteEmployee(name, requesterName, requesterRole) {
  if (!isRequesterAdmin_(requesterName)) {
    return { success: false, message: "You do not have permission to delete employees." };
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_EMPLOYEES);
  if (!sheet) return { success: false };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim().toLowerCase() === name.trim().toLowerCase()) {
      // Re-verified here, not just hidden in the UI: NO admin account —
      // core (Pramil/Venu) or otherwise — can ever be deleted through
      // this app. Admin accounts are removable only by directly editing
      // the EMPLOYEES sheet in Google Sheets.
      const role = (data[i][2] || "employee").toString().trim().toLowerCase();
      if (role === "admin") return { success: false, message: "Admin accounts can't be deleted from this panel." };
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, message: "Employee not found." };
}

// ── SKU MASTER EDITOR (admin only) ────────────────────────────
function getSkuMasterFull() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SKU);
  if (!sheet) return { headers: [], rows: [] };
  const data = sheet.getDataRange().getValues();
  if (data.length < 1) return { headers: [], rows: [] };
  const headers = data[0].map(h => h.toString());
  const rows = data.slice(1).map((r, i) => ({
    rowIndex: i + 2,
    cells: r.map(c => c.toString())
  }));
  return { headers, rows };
}

function updateSkuCell(rowIndex, colIndex, value, requesterName, requesterRole) {
  try {
    if (!employeeHasModule_(requesterName, requesterRole, "SKU_MASTER")) {
      return { success: false, message: "You do not have permission to edit SKU Master." };
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_SKU);
    if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };
    sheet.getRange(rowIndex, colIndex + 1).setValue(value);
    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
}

/** Writes an entire SKU_MASTER row in one batch call — backs the
 *  "Update" button next to each row in the SKU Master editor (see
 *  updateSkuRowNow_ in the HTML), so editing several fields (Landing
 *  Price, UPC, etc.) commits them all in one explicit action/round-trip
 *  with visible "Updating…" feedback, instead of relying on a silent
 *  per-field save on blur. Every place that reads a SKU's data —
 *  RO Invoice/Tally Excel, Box Details, Labels, the New Shipment form —
 *  already looks SKU_MASTER up fresh (or via the client's skuData,
 *  refreshed right after this call succeeds — see updateSkuRowNow_), so
 *  writing here is all it takes for the change to be live everywhere. */
function updateSkuRow(rowIndex, cells, requesterName, requesterRole) {
  try {
    if (!employeeHasModule_(requesterName, requesterRole, "SKU_MASTER")) {
      return { success: false, message: "You do not have permission to edit SKU Master." };
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_SKU);
    if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };
    if (rowIndex < 2) return { success: false, message: "Cannot update the header row." };
    if (!Array.isArray(cells) || !cells.length) return { success: false, message: "No data to update." };
    sheet.getRange(rowIndex, 1, 1, cells.length).setValues([cells]);
    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
}

/** Delete a row from SKU_MASTER by its 1-based sheet row index.
 *  Requires the SKU_MASTER_DELETE module specifically (not just
 *  SKU_MASTER) — enforced here now, not just hidden client-side. */
function deleteSkuRow(rowIndex, requesterName, requesterRole) {
  try {
    if (!employeeHasModule_(requesterName, requesterRole, "SKU_MASTER_DELETE")) {
      return { success: false, message: "You do not have permission to delete SKU rows." };
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_SKU);
    if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };
    if (rowIndex < 2) return { success: false, message: "Cannot delete the header row." };
    sheet.deleteRow(rowIndex);
    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
}

function addSkuRow(cells, requesterName, requesterRole) {
  try {
    if (!employeeHasModule_(requesterName, requesterRole, "SKU_MASTER")) {
      return { success: false, message: "You do not have permission to add SKU rows." };
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_SKU);
    if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };
    sheet.appendRow(cells);
    return { success: true, rowIndex: sheet.getLastRow() };
  } catch (err) { return { success: false, message: err.message }; }
}

/** Reads SKU_MASTER's header row and returns {HEADER_NAME_UPPER: colIndex0based}.
 *  Used so column lookups go by NAME rather than assumed fixed position —
 *  a real column-position mismatch already happened once (a pre-existing
 *  CASE_PACK_SIZE column at O meant migrateSkuMasterAddPlatformItemIdColumns'
 *  old fixed-index check silently skipped adding SWIGGY_ITEM_ID there), so
 *  every column touched by name below is now resilient to whatever other
 *  columns you've added to the sheet, in whatever order. */
function getSkuHeaderMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SKU);
  if (!sheet) return {};
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    const key = (h || "").toString().trim().toUpperCase();
    if (key && map[key] === undefined) map[key] = i; // first occurrence wins on accidental dupes
  });
  return map;
}

// ── SKU DATA ──────────────────────────────────────────────────
function getSkuData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SKU);
  if (!sheet) return { skus: [], data: [] };
  const data = sheet.getDataRange().getValues();
  if (data.length < 1) return [];
  const hm = {};
  data[0].forEach((h, i) => {
    const key = (h || "").toString().trim().toUpperCase();
    if (key && hm[key] === undefined) hm[key] = i;
  });
  // Core columns are looked up by name with a fallback to their original
  // fixed position (0-7) in case an older sheet is somehow missing a
  // header cell — the RO/platform-item-id columns further right have NO
  // positional fallback, since those are exactly the columns that can
  // shift around other custom columns you've added (e.g. CASE_PACK_SIZE).
  const c = {
    inventorySku: hm['INVENTORY_SKU'] !== undefined ? hm['INVENTORY_SKU'] : 0,
    sku:          hm['SKU'] !== undefined ? hm['SKU'] : 1,
    amazonSku:    hm['AMAZON_SKU'] !== undefined ? hm['AMAZON_SKU'] : 2,
    amazon:       hm['AMAZON'] !== undefined ? hm['AMAZON'] : 3,
    blinkit:      hm['BLINKIT'] !== undefined ? hm['BLINKIT'] : 4,
    swiggy:       hm['SWIGGY'] !== undefined ? hm['SWIGGY'] : 5,
    zepto:        hm['ZEPTO'] !== undefined ? hm['ZEPTO'] : 6,
    weight:       hm['WEIGHT_PER_UNIT'] !== undefined ? hm['WEIGHT_PER_UNIT'] : 7,
    blinkitItemId:hm['BLINKIT_ITEM_ID'],
    description:  hm['DESCRIPTION'],
    mrp:          hm['MRP'],
    hsn:          hm['HSN'],
    tax:          hm['TAX'],
    blinkitLandingPrice: hm['BLINKIT_LANDING_PRICE'],
    swiggyItemId: hm['SWIGGY_ITEM_ID'],
    zeptoItemId:  hm['ZEPTO_ITEM_ID'],
    zeptoLandingPrice: hm['ZEPTO_LANDING_PRICE'],
    swiggyLandingPrice: hm['SWIGGY_LANDING_PRICE'],
    // Product Label printing fields (see migrateSkuMasterAddLabelColumns
    // and generateSkuLabelTspl_impl_) — physical product attributes, so
    // deliberately ONE value per SKU rather than per-platform like the
    // barcode/MRP columns above.
    mfgDate:      hm['MFG_DATE'],
    productType:  hm['PRODUCT_TYPE'],
    color:        hm['COLOR'],
    country:      hm['COUNTRY'],
    packQty:      hm['PACK_QTY']
  };
  const str_ = (r, idx) => idx === undefined ? "" : (r[idx] || "").toString().trim();
  const num_ = (r, idx) => idx === undefined ? 0 : (parseFloat(r[idx]) || 0);
  // MFG_DATE specifically: Sheets auto-converts date-looking typed text
  // (e.g. "Aug-26") into a real Date cell — plain str_ above would then
  // print that Date object's full JS toString() ("Wed Aug 26 2026
  // 00:00:00 GMT+0530...") straight onto the label. Format it down to
  // "AUG-26" whenever the cell holds (or contains text that reads like)
  // a date; left alone only if it's genuinely unparseable as one.
  // Checks BOTH forms since either can turn up here: a true Date object
  // (the normal case — Sheets auto-converted what was typed), or a
  // plain STRING that already reads like Date.toString() output (e.g.
  // pasted in from elsewhere as unformatted text, or the column was set
  // to "Plain text" format before typing, which stops Sheets' own
  // auto-conversion from ever happening) — the first fix only caught
  // the former.
  const MFG_DATE_STRING_PATTERN_ = /^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}(:\d{2})?/;
  const dateStr_ = (r, idx) => {
    if (idx === undefined) return "";
    const v = r[idx];
    if (!v) return "";
    let d = null;
    if (Object.prototype.toString.call(v) === "[object Date]") {
      d = v;
    } else if (MFG_DATE_STRING_PATTERN_.test(v.toString().trim())) {
      const parsed = new Date(v.toString().trim());
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (d) {
      return Utilities.formatDate(d, Session.getScriptTimeZone() || "Etc/UTC", "MMM-yy").toUpperCase();
    }
    return v.toString().trim();
  };
  // A row is kept if it has EITHER a normal SKU (col B) or an Amazon SKU
  // (col C) — some rows exist only to carry an extra Amazon listing for
  // a product that already has its own row under its normal SKU, so col
  // B is intentionally blank on those rows.
  const rows = data.slice(1).filter(r => r[c.sku] || r[c.amazonSku]);
  const result = rows.map(r => ({
    inventorySku: str_(r, c.inventorySku), // mapping to Travalate Inventory's Master_SKU; blank = unmapped
    sku:        str_(r, c.sku),
    amazonSku:  str_(r, c.amazonSku),
    amazon:     r[c.amazon] || "",
    blinkit:    r[c.blinkit] || "",
    swiggy:     r[c.swiggy] || "",
    zepto:      r[c.zepto] || "",
    weight:     num_(r, c.weight),   // weight per single unit in kg
    blinkitItemId: str_(r, c.blinkitItemId),
    description:   str_(r, c.description),
    mrp:           num_(r, c.mrp),
    hsn:           str_(r, c.hsn),
    tax:           num_(r, c.tax),      // percentage, e.g. 18 for 18%
    // Each platform has its own landing price — Blinkit's is Blinkit's
    // own tax-inclusive rate; Zepto's is what Zepto's own PO calls
    // "Unit Base Cost". Kept as two separate columns since the same SKU
    // can legitimately cost different amounts on each platform.
    blinkitLandingPrice: num_(r, c.blinkitLandingPrice),
    zeptoLandingPrice:   num_(r, c.zeptoLandingPrice),
    swiggyLandingPrice:  num_(r, c.swiggyLandingPrice),
    swiggyItemId:  str_(r, c.swiggyItemId),
    zeptoItemId:   str_(r, c.zeptoItemId),
    mfgDate:       dateStr_(r, c.mfgDate),
    productType:   str_(r, c.productType),
    color:         str_(r, c.color),
    country:       str_(r, c.country),
    packQty:       str_(r, c.packQty)
  }));
  return result;
}

/** ONE-TIME SETUP — run this once from the Apps Script editor (select
 *  migrateSkuMasterAddPlatformItemIdColumns in the function dropdown, then
 *  ▶ Run) after deploying this update. It only touches the HEADER row,
 *  and looks everything up by NAME rather than a fixed column position —
 *  so it works correctly no matter what other columns (e.g. CASE_PACK_SIZE)
 *  you've already added to the sheet, and in whatever order:
 *   - Renames the "ITEM_ID" header to "BLINKIT_ITEM_ID" (only if
 *     BLINKIT_ITEM_ID doesn't already exist elsewhere).
 *   - Appends "SWIGGY_ITEM_ID" and "ZEPTO_ITEM_ID" as brand-new columns at
 *     the true end of the sheet, only if each doesn't already exist
 *     somewhere in the header row.
 *   - Renames "LANDING_PRICE" to "BLINKIT_LANDING_PRICE" (same rule as
 *     ITEM_ID above), then INSERTS "ZEPTO_LANDING_PRICE" as a real new
 *     column immediately after it — a true sheet-column insertion (not
 *     an append), so it always ends up sitting right next to Blinkit's
 *     landing price regardless of what else you've added to the right
 *     of it. Every other column shifts right to make room, but since
 *     every lookup in this file goes by header NAME, nothing else needs
 *     to change.
 *  No existing data in any row is modified or moved. Safe to re-run —
 *  running it again after it's already fully applied is a no-op. */
function migrateSkuMasterAddPlatformItemIdColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SKU);
  if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const upper = headers.map(h => (h || "").toString().trim().toUpperCase());
  const notes = [];

  const itemIdIdx = upper.indexOf("ITEM_ID");
  const blinkitIdx = upper.indexOf("BLINKIT_ITEM_ID");
  if (blinkitIdx === -1 && itemIdIdx !== -1) {
    sheet.getRange(1, itemIdIdx + 1).setValue("BLINKIT_ITEM_ID");
    upper[itemIdIdx] = "BLINKIT_ITEM_ID";
    notes.push("Renamed column " + columnLetter_(itemIdIdx + 1) + " from ITEM_ID to BLINKIT_ITEM_ID.");
  } else if (blinkitIdx !== -1) {
    notes.push("BLINKIT_ITEM_ID already present in column " + columnLetter_(blinkitIdx + 1) + " — left as-is.");
  } else {
    notes.push("No ITEM_ID or BLINKIT_ITEM_ID header found — add one manually (used for Blinkit PO matching) if you need it.");
  }

  // Append at the true end of the sheet, one at a time, re-deriving "end"
  // after each addition so the two new columns never land on top of each
  // other or an existing column.
  ["SWIGGY_ITEM_ID", "ZEPTO_ITEM_ID"].forEach(name => {
    if (upper.indexOf(name) !== -1) {
      notes.push(name + " already present in column " + columnLetter_(upper.indexOf(name) + 1) + " — left as-is.");
      return;
    }
    const nextCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, nextCol).setValue(name);
    upper.push(name);
    notes.push("Added " + name + " at column " + columnLetter_(nextCol) + ".");
  });

  // Rename LANDING_PRICE -> BLINKIT_LANDING_PRICE, then INSERT (not
  // append) ZEPTO_LANDING_PRICE immediately after it, so the two sit
  // side by side for easy comparison regardless of what's elsewhere in
  // the sheet (e.g. the ITEM_ID columns appended above, or CASE_PACK_SIZE).
  const landingIdx = upper.indexOf("LANDING_PRICE");
  const blinkitLandingIdx = upper.indexOf("BLINKIT_LANDING_PRICE");
  let resolvedBlinkitLandingIdx = blinkitLandingIdx;
  if (blinkitLandingIdx === -1 && landingIdx !== -1) {
    sheet.getRange(1, landingIdx + 1).setValue("BLINKIT_LANDING_PRICE");
    upper[landingIdx] = "BLINKIT_LANDING_PRICE";
    resolvedBlinkitLandingIdx = landingIdx;
    notes.push("Renamed column " + columnLetter_(landingIdx + 1) + " from LANDING_PRICE to BLINKIT_LANDING_PRICE.");
  } else if (blinkitLandingIdx !== -1) {
    notes.push("BLINKIT_LANDING_PRICE already present in column " + columnLetter_(blinkitLandingIdx + 1) + " — left as-is.");
  } else {
    notes.push("No LANDING_PRICE or BLINKIT_LANDING_PRICE header found — add one manually (Blinkit's tax-inclusive landing cost) if you need it.");
  }

  if (upper.indexOf("ZEPTO_LANDING_PRICE") !== -1) {
    notes.push("ZEPTO_LANDING_PRICE already present in column " + columnLetter_(upper.indexOf("ZEPTO_LANDING_PRICE") + 1) + " — left as-is.");
  } else if (resolvedBlinkitLandingIdx !== -1) {
    sheet.insertColumnAfter(resolvedBlinkitLandingIdx + 1); // 1-based column number
    const newCol = resolvedBlinkitLandingIdx + 2;
    sheet.getRange(1, newCol).setValue("ZEPTO_LANDING_PRICE");
    notes.push("Inserted ZEPTO_LANDING_PRICE right after BLINKIT_LANDING_PRICE, at column " + columnLetter_(newCol) + ".");
  } else {
    notes.push("Could not place ZEPTO_LANDING_PRICE next to a Blinkit landing price column since none was found — add ZEPTO_LANDING_PRICE manually.");
  }

  return { success: true, message: notes.join(" ") };
}

/** ONE-TIME SETUP — run this once from the Apps Script editor (select
 *  migrateSkuMasterAddSwiggyLandingPriceColumn in the function dropdown,
 *  then ▶ Run) to add Swiggy's own landing price column, needed now that
 *  Swiggy has its own PO-driven flow (mirroring Blinkit/Zepto). Looks up
 *  everything by header NAME, same as migrateSkuMasterAddPlatformItemIdColumns
 *  above — works no matter what other columns already exist or what order
 *  they're in. Inserts (not appends) SWIGGY_LANDING_PRICE immediately after
 *  ZEPTO_LANDING_PRICE if present, else immediately after
 *  BLINKIT_LANDING_PRICE, so the three landing-price columns end up sitting
 *  side by side for easy comparison. No existing data is modified or
 *  moved. Safe to re-run — a no-op if the column already exists. */
function migrateSkuMasterAddSwiggyLandingPriceColumn() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SKU);
  if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const upper = headers.map(h => (h || "").toString().trim().toUpperCase());

  if (upper.indexOf("SWIGGY_LANDING_PRICE") !== -1) {
    return { success: true, message: "SWIGGY_LANDING_PRICE already present in column " + columnLetter_(upper.indexOf("SWIGGY_LANDING_PRICE") + 1) + " — left as-is." };
  }

  const zeptoLandingIdx = upper.indexOf("ZEPTO_LANDING_PRICE");
  const blinkitLandingIdx = upper.indexOf("BLINKIT_LANDING_PRICE");
  const anchorIdx = zeptoLandingIdx !== -1 ? zeptoLandingIdx : blinkitLandingIdx;
  if (anchorIdx === -1) {
    return { success: false, message: "Could not place SWIGGY_LANDING_PRICE next to a landing price column since neither BLINKIT_LANDING_PRICE nor ZEPTO_LANDING_PRICE was found — add SWIGGY_LANDING_PRICE manually." };
  }
  sheet.insertColumnAfter(anchorIdx + 1); // 1-based column number
  const newCol = anchorIdx + 2;
  sheet.getRange(1, newCol).setValue("SWIGGY_LANDING_PRICE");
  return { success: true, message: "Inserted SWIGGY_LANDING_PRICE at column " + columnLetter_(newCol) + "." };
}

/** ONE-TIME SETUP — run this once from the Apps Script editor (select
 *  migrateSkuMasterAddLabelColumns in the function dropdown, then ▶ Run)
 *  to add the columns Product Label printing needs (see
 *  generateSkuLabelTspl_impl_ in the PRODUCT LABEL PRINTING section
 *  below): MFG_DATE, PRODUCT_TYPE, COLOR, COUNTRY, PACK_QTY. These are
 *  physical product attributes — deliberately ONE column each (not
 *  split per platform like BLINKIT/SWIGGY/ZEPTO), since a product's
 *  color/type/origin/manufacture date don't change depending on which
 *  platform sells it; only its barcode and MRP do, and those columns
 *  already exist. Appended at the true end of the sheet, one at a
 *  time, same idempotent by-NAME pattern as the migrations above — safe
 *  to re-run, a no-op for any column that already exists. Once added,
 *  they show up automatically in the SKU Master tab's editor grid (it
 *  reads the sheet's own header row) — nothing else to wire up. */
function migrateSkuMasterAddLabelColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SKU);
  if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const upper = headers.map(h => (h || "").toString().trim().toUpperCase());
  const notes = [];

  ["MFG_DATE", "PRODUCT_TYPE", "COLOR", "COUNTRY", "PACK_QTY"].forEach(name => {
    if (upper.indexOf(name) !== -1) {
      notes.push(name + " already present in column " + columnLetter_(upper.indexOf(name) + 1) + " — left as-is.");
      return;
    }
    const nextCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, nextCol).setValue(name);
    upper.push(name);
    notes.push("Added " + name + " at column " + columnLetter_(nextCol) + ".");
  });

  return { success: true, message: notes.join(" ") };
}

/** Converts a 1-based column number to its A1 letter (1→A, 27→AA, etc). */
function columnLetter_(col) {
  let s = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}


// Called when an employee maps a Shipment Manager SKU to an
// Inventory (Travalate) SKU from the dropdown in the entry form,
// either because it was blank or needed correcting. `sku` may be either
// a normal SKU (column B) or an Amazon SKU (column C) — whichever list
// the employee was actually choosing from.
function setInventorySkuMapping(sku, inventorySku) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_SKU);
    if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };

    const data = sheet.getDataRange().getValues();
    const skuTrim = sku.toString().trim();
    for (let i = 1; i < data.length; i++) {
      const normalMatch = (data[i][1] || "").toString().trim() === skuTrim;
      const amazonMatch = (data[i][2] || "").toString().trim() === skuTrim;
      if (normalMatch || amazonMatch) {
        sheet.getRange(i + 1, 1).setValue(inventorySku.toString().trim());
        return { success: true };
      }
    }
    return { success: false, message: "SKU not found in SKU_MASTER: " + skuTrim };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── SET RO INVOICE FIELDS FOR A SKU ───────────────────────────
// Updates the Blinkit RO Invoice fields for one SKU row — BLINKIT_ITEM_ID,
// DESCRIPTION, MRP, HSN, TAX, BLINKIT_LANDING_PRICE — resolving each column
// by header NAME (via getSkuHeaderMap_) rather than an assumed fixed
// position, so this keeps working correctly regardless of any other
// columns (e.g. CASE_PACK_SIZE) you've added to the sheet. `sku` may be
// either a normal SKU or an Amazon SKU, same lookup pattern as
// setInventorySkuMapping. fields is a partial object — only the keys
// actually present are updated, so this works both for the full
// "Map Now" flow (all 6 at once) and for editing just one field later.
function setRoFieldsForSku(sku, fields) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_SKU);
    if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };

    const hm = getSkuHeaderMap_();
    const colFor = { blinkitItemId: hm['BLINKIT_ITEM_ID'], description: hm['DESCRIPTION'], mrp: hm['MRP'], hsn: hm['HSN'], tax: hm['TAX'], blinkitLandingPrice: hm['BLINKIT_LANDING_PRICE'] };

    const data = sheet.getDataRange().getValues();
    const skuTrim = sku.toString().trim();
    for (let i = 1; i < data.length; i++) {
      const normalMatch = (data[i][1] || "").toString().trim() === skuTrim;
      const amazonMatch = (data[i][2] || "").toString().trim() === skuTrim;
      if (!normalMatch && !amazonMatch) continue;

      const row = i + 1;
      if (fields.blinkitItemId      !== undefined && colFor.blinkitItemId      !== undefined) sheet.getRange(row, colFor.blinkitItemId + 1).setValue(fields.blinkitItemId);
      if (fields.description        !== undefined && colFor.description       !== undefined) sheet.getRange(row, colFor.description + 1).setValue(fields.description);
      if (fields.mrp                !== undefined && colFor.mrp               !== undefined) sheet.getRange(row, colFor.mrp + 1).setValue(Number(fields.mrp) || 0);
      if (fields.hsn                !== undefined && colFor.hsn               !== undefined) sheet.getRange(row, colFor.hsn + 1).setValue(fields.hsn);
      if (fields.tax                !== undefined && colFor.tax               !== undefined) sheet.getRange(row, colFor.tax + 1).setValue(Number(fields.tax) || 0);
      if (fields.blinkitLandingPrice !== undefined && colFor.blinkitLandingPrice !== undefined) sheet.getRange(row, colFor.blinkitLandingPrice + 1).setValue(Number(fields.blinkitLandingPrice) || 0);
      return { success: true };
    }
    return { success: false, message: "SKU not found in SKU_MASTER: " + skuTrim };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── FETCH INVENTORY SKU LIST (for mapping dropdown) ───────────
// Calls the Travalate Inventory Web App to pull its current
// Master_SKU list, so an employee can pick the correct match
// instead of typing it by hand.
function getInventorySkuListFromInventory() {
  try {
    const res = callInventoryWebApp_({ action: "getSkuList" });
    if (!res.success) return { success: false, message: res.error || "Failed to fetch Inventory SKU list." };
    return { success: true, skus: res.skus || [] };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── FETCH CURRENT STOCK FOR A SKU (live, shown next to Qty) ───
// Looks up this Shipment Manager SKU's INVENTORY_SKU mapping, then
// asks Travalate Inventory for its current stock level. `sku` may be
// either a normal SKU or an Amazon SKU. Returns stock:null (not an
// error) when the SKU has no mapping yet, or when Inventory has no row
// for it — the UI just shows "—" in that case.
function getInventoryStockForSku(sku) {
  try {
    const skuRows = getSkuData();
    const skuKey = String(sku).trim().toUpperCase();
    const match = skuRows.find(r =>
      String(r.sku).trim().toUpperCase() === skuKey ||
      String(r.amazonSku).trim().toUpperCase() === skuKey
    );
    const inventorySku = match ? (match.inventorySku || "").trim() : "";
    if (!inventorySku) return { success: true, stock: null, unmapped: true };

    const res = callInventoryWebApp_({ action: "getStock", sku: inventorySku });
    if (!res.success) return { success: false, message: res.error || "Failed to fetch stock." };
    return { success: true, stock: res.stock };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── FETCH CURRENT STOCK FOR MANY SKUS AT ONCE (Blinkit Shipment Planning's
//    QTY column) ────────────────────────────────────────────────
// Same mapping/lookup as getInventoryStockForSku above. Used to fire one
// HTTP round trip PER DISTINCT SKU in the grid (via fetchAll, "parallel"
// but still N real requests under the hood) — every 2 minutes, for as
// long as the grid stayed open (see startSnapshotInvStockAutoRefresh_ in
// ShipmentManagerIndex.html). With a grid holding dozens of distinct
// SKUs that was genuinely slow, and gave each individual request its
// own chance to fail/time out under load — which is exactly what showed
// up as scattered "?" cells (a failed lookup renders the same as a
// SKU that's legitimately missing from Inventory's stock register; see
// invText's fallback logic in ShipmentManagerIndex.html).
//
// Now makes exactly ONE HTTP call total, regardless of how many
// distinct SKUs are in the grid — the new getStockSnapshot action
// (added for the "Inventory Snapshot" nav tab/topbar widget) has
// Inventory read its ENTIRE stock register once and hand back every
// SKU's current value in one response; this just looks each grid SKU
// up in that single result instead of asking for it individually.
// Returns { success, stocks: { <sku>: { stock, unmapped? , error? } } } —
// same shape as before, so no client-side change was needed.
function getSnapshotInventoryStock(skuList) {
  try {
    if (!INVENTORY_WEBAPP_URL || INVENTORY_WEBAPP_URL.indexOf("PASTE_YOUR") === 0) {
      return { success: false, message: "Inventory Web App URL is not configured yet." };
    }
    const skuRows = getSkuData();
    const stocks = {};
    const needsLookup = []; // [{raw, inventorySku}]

    (skuList || []).forEach(function (sku) {
      const raw = String(sku || "").trim();
      if (!raw || stocks[raw] !== undefined) return;
      const skuKey = raw.toUpperCase();
      const match = skuRows.find(function (r) {
        return String(r.sku).trim().toUpperCase() === skuKey ||
          String(r.amazonSku).trim().toUpperCase() === skuKey ||
          String(r.inventorySku).trim().toUpperCase() === skuKey;
      });
      const inventorySku = match ? (match.inventorySku || "").trim() : raw;
      if (!inventorySku) { stocks[raw] = { stock: null, unmapped: true }; return; }
      needsLookup.push({ raw: raw, inventorySku: inventorySku });
    });

    if (!needsLookup.length) return { success: true, stocks: stocks };

    const snap = callInventoryWebApp_({ action: "getStockSnapshot" });
    if (!snap || !snap.success) {
      const errMsg = (snap && (snap.error || snap.message)) || "Could not reach Inventory.";
      needsLookup.forEach(function (item) { stocks[item.raw] = { stock: null, error: errMsg }; });
      return { success: true, stocks: stocks };
    }

    const byInvSku = {};
    (snap.stocks || []).forEach(function (row) { byInvSku[String(row.sku).trim().toUpperCase()] = row.qty; });

    needsLookup.forEach(function (item) {
      const qty = byInvSku[item.inventorySku.toUpperCase()];
      // Present in SKU_MASTER's mapping but genuinely not in Inventory's
      // stock register (never stocked / typo'd) → stock:null, same as
      // before — the client shows this as "?", same as any other
      // lookup miss, not "-" (that's reserved for no mapping AT ALL).
      stocks[item.raw] = qty !== undefined ? { stock: qty } : { stock: null };
    });

    return { success: true, stocks: stocks };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── ADD / UPDATE UPC FOR A SKU+PLATFORM ───────────────────────
// platform must be one of: blinkit, swiggy, zepto, amazon (case-insensitive)
// For amazon, `sku` is the AMAZON SKU (column C) — the employee searches
// and picks from Amazon's own SKU list when Amazon is the platform, so
// by the time this is called, `sku` already IS an Amazon SKU, not the
// normal column-B SKU.
function addUpc(sku, platform, upc) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_SKU);
    if (!sheet) return { success: false, message: "SKU_MASTER sheet not found." };

    const platformKey = platform.toLowerCase().trim();
    const platformCol = { blinkit: 5, swiggy: 6, zepto: 7 }[platformKey];
    const isAmazon = platformKey === "amazon";
    if (!platformCol && !isAmazon) return { success: false, message: "Unknown platform: " + platform };

    const data = sheet.getDataRange().getValues();
    const skuTrim = sku.toString().trim();
    // Amazon's own UPC lives in column D, matched against column C
    // (AMAZON_SKU). Every other platform matches against column B (SKU)
    // as before.
    const matchCol = isAmazon ? 2 : 1;
    const writeCol = isAmazon ? 4 : platformCol;
    for (let i = 1; i < data.length; i++) {
      if ((data[i][matchCol] || "").toString().trim() === skuTrim) {
        sheet.getRange(i + 1, writeCol).setValue(upc.toString().trim());
        return { success: true };
      }
    }
    return { success: false, message: "SKU not found in SKU_MASTER: " + skuTrim };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── TRAVALATE INVENTORY INTEGRATION HELPERS ───────────────────

/** Low-level POST to the Inventory Web App. Returns the parsed JSON
 *  response, or { success:false, error: "..." } on any failure
 *  (network error, non-200, bad JSON). Never throws. */
function callInventoryWebApp_(body) {
  try {
    if (!INVENTORY_WEBAPP_URL || INVENTORY_WEBAPP_URL.indexOf("PASTE_YOUR") === 0) {
      return { success: false, error: "Inventory Web App URL is not configured yet." };
    }
    const fullBody = Object.assign({ secret: INVENTORY_SHARED_SECRET }, body);
    const resp = UrlFetchApp.fetch(INVENTORY_WEBAPP_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(fullBody),
      muteHttpExceptions: true
    });
    const text = resp.getContentText();
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      return { success: false, error: "Inventory returned a non-JSON response (HTTP " + resp.getResponseCode() + ")." };
    }
  } catch (err) {
    return { success: false, error: "Could not reach Inventory: " + err.message };
  }
}

/** Public: live company-wide current-stock-per-SKU pull straight from
 *  the Travalate Inventory Management system's own running stock
 *  register — NOT the Blinkit-specific, upload-based Snapshot tab
 *  (getSnapshotMatrix/INVENTORY_SNAPSHOT_LOG), which is a periodic
 *  manual import. Backs the "Inventory Snapshot" nav tab and the
 *  topbar stock widget — see loadInventoryLiveSnapshot_ in
 *  ShipmentManagerIndex.html. Reuses callInventoryWebApp_'s existing
 *  auth (INVENTORY_SHARED_SECRET) against Inventory's own new
 *  getCurrentStockSnapshot() (action "getStockSnapshot" in its doPost). */
function getInventoryStockSnapshot() {
  return callInventoryWebApp_({ action: "getStockSnapshot" });
}

/** Builds a { "INVENTORY_SKU": totalQty } map from a shipment's boxes,
 *  using each line item's Shipment Manager SKU mapped through
 *  SKU_MASTER's INVENTORY_SKU column. A line item's `sku` may be either
 *  a normal SKU (column B) or an Amazon SKU (column C) — both resolve
 *  through the same lookup since a product can have several different
 *  Amazon SKUs (or rows) that all ultimately map to the SAME
 *  INVENTORY_SKU; quantities are summed across all of them below.
 *  Items with no mapping are returned separately under "unmapped" so
 *  the caller can decide whether to block or warn. */
function buildInventoryQtyMap_(boxes, skuRowsOverride) {
  // PERFORMANCE: submitShipment() reads SKU_MASTER once and passes it in
  // via skuRowsOverride so this doesn't re-read the whole sheet a second
  // time in the same request (validateAndUpdatePoShipped_ needs its own
  // copy too). Falls back to a fresh read for any other/older caller.
  const skuRows = skuRowsOverride || getSkuData(); // [{ inventorySku, sku, amazonSku, ... }]
  const mapBySku = {};
  skuRows.forEach(r => {
    if (r.sku)       mapBySku[String(r.sku).trim().toUpperCase()]       = r.inventorySku;
    if (r.amazonSku) mapBySku[String(r.amazonSku).trim().toUpperCase()] = r.inventorySku;
  });

  const qtyMap = {};
  const unmapped = [];
  (boxes || []).forEach(box => {
    (box.items || []).forEach(item => {
      const skuKey = String(item.sku).trim().toUpperCase();
      const inventorySku = (mapBySku[skuKey] || "").trim();
      if (!inventorySku) {
        if (unmapped.indexOf(item.sku) === -1) unmapped.push(item.sku);
        return;
      }
      const key = inventorySku.trim().toUpperCase();
      qtyMap[key] = (qtyMap[key] || 0) + (parseInt(item.qty, 10) || 0);
    });
  });
  return { qtyMap, unmapped };
}

/** Builds the cell-note comment Inventory will show on each stock cell,
 *  matching the existing manual-entry note style:
 *    23-Jun 10:36 | Karamveer | -100 (Out) | BLINKIT - BENGALURU  (49990010044810)
 *  i.e. "PLATFORM - CITY  (PO NUMBER)", uppercase platform/city, with the
 *  timestamp/employee/qty portion added automatically by Inventory itself.
 *  Box numbers are intentionally omitted (a SKU can span multiple boxes).
 *
 *  suffix (optional) is appended after a " | " separator — used for the
 *  delete/reversal case to add "Shipment Deleted" at the end, e.g.:
 *    BLINKIT - BENGALURU  (49990010044810) | Shipment Deleted */
function buildShipmentComment_(platform, city, poNumber, suffix) {
  const platformPart = (platform || "").toString().trim().toUpperCase();
  const cityPart      = (city || "").toString().trim().toUpperCase();
  const poPart         = (poNumber || "").toString().trim();
  const base = platformPart + " - " + cityPart + (poPart ? "  (" + poPart + ")" : "");
  return suffix ? base + " | " + suffix : base;
}

/** Pushes a shipment's current box/item state into Inventory as an
 *  Outward stock deduction (diffed against whatever was previously
 *  synced for this shipment ID — see syncShipmentToInventory on the
 *  Inventory side for the idempotency logic).
 *
 *  Called after create AND after every edit, with the shipment's
 *  FULL current box list (not just the changed lines) — Inventory
 *  computes the delta itself.
 *
 *  Returns { success, unmapped, message } — unmapped SKUs are
 *  reported but never block the shipment save itself. */
function syncShipmentInventory_(shipmentId, boxes, date, employee, platform, city, poNumber, skuRowsOverride) {
  const { qtyMap, unmapped } = buildInventoryQtyMap_(boxes, skuRowsOverride);
  const comment = buildShipmentComment_(platform, city, poNumber);
  let invResult = { success: true, applied: [], skipped: [] };
  if (Object.keys(qtyMap).length || unmapped.length === 0) {
    invResult = callInventoryWebApp_({ action: "sync", shipmentId, items: qtyMap, date, employee, comment });
  }
  return {
    success: invResult.success !== false,
    unmapped: unmapped,
    skippedByInventory: invResult.skipped || [],
    message: invResult.success === false ? invResult.error : ""
  };
}

/** Fully reverses a shipment's inventory impact (used on delete). */
function reverseShipmentInventory_(shipmentId, date, employee, platform, city, poNumber) {
  const comment = buildShipmentComment_(platform, city, poNumber, "Shipment Deleted");
  return callInventoryWebApp_({ action: "reverse", shipmentId, date, employee, comment });
}

// ── SUBMIT SHIPMENT ───────────────────────────────────────────
function submitShipment(payload) {
  /*
  payload = {
    employee, platform, poNumber, date, city,
    boxes: [
      { boxNumber, items: [{ sku, upc, qty, weightPerUnit }] }
    ]
  }
  */
  try {
    const dupCheck = findDuplicateShipmentField_(payload.poNumber, payload.invoiceNumber, null);
    if (dupCheck.poDuplicate) {
      return { success: false, message: "PO Number \"" + payload.poNumber + "\" is already used by another shipment. Please use a unique PO Number." };
    }
    if (dupCheck.invoiceDuplicate) {
      return { success: false, message: "Invoice Number \"" + payload.invoiceNumber + "\" is already used by another shipment. Please use a unique Invoice Number." };
    }

    // PO-driven platforms only (Blinkit, Zepto): validate against the PO's
    // remaining balance and update its SHIPPED_QTY/STATUS — this is the
    // ONLY place a PO's line items ever transition to FULFILLED (and so
    // the only place a fully-used PO ever automatically drops out of its
    // "open POs" dropdown list). Runs BEFORE anything is persisted, so an
    // over-limit submission is rejected outright rather than saved and
    // silently left unreflected in the PO sheet.
    // PERFORMANCE: SKU_MASTER is read ONCE here and shared with both
    // validateAndUpdatePoShipped_ and syncShipmentInventory_ below,
    // instead of each independently re-reading the whole sheet.
    const sharedSkuRows = getSkuData();

    const submitPlatform = (payload.platform || "").toString().trim().toLowerCase();
    if (poPlatformConfig_(submitPlatform) && payload.poNumber) {
      const poUpdate = validateAndUpdatePoShipped_(submitPlatform, payload.poNumber, payload.boxes, null, false, sharedSkuRows);
      if (!poUpdate.success) {
        return { success: false, message: poUpdate.errors.join(" ") };
      }
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(SHEET_LOG);
    if (!logSheet) {
      logSheet = ss.insertSheet(SHEET_LOG);
      logSheet.appendRow([
        "TIMESTAMP","EMPLOYEE","PLATFORM","PO NUMBER","DATE","CITY",
        "BOX NO","SKU","UPC","QTY","NET WEIGHT (kg)","BOX WEIGHT (kg)","TOTAL WEIGHT (kg)"
      ]);
    }

    const ts = new Date();
    const BOX_WEIGHT = 1; // 1 kg per box

    // PERFORMANCE: build every row in memory first, then write them all
    // in ONE call instead of one appendRow() round-trip per item/box —
    // a 5-box, 2-item shipment used to mean 15 separate API calls here.
    const logRows = [];
    for (const box of payload.boxes) {
      let boxNetWeight = 0;
      for (const item of box.items) {
        const netW = parseFloat(item.weightPerUnit) * parseInt(item.qty);
        boxNetWeight += netW;
        logRows.push([
          ts,
          payload.employee,
          payload.platform,
          payload.poNumber,
          payload.date,
          payload.city,
          box.boxNumber,
          item.sku,
          item.upc,
          item.qty,
          netW.toFixed(3),
          "",
          ""
        ]);
      }
      // Summary row per box (box weight + grand total for that box)
      logRows.push([
        ts, payload.employee, payload.platform, payload.poNumber, payload.date, payload.city,
        box.boxNumber + " TOTAL", "", "", "",
        boxNetWeight.toFixed(3),
        BOX_WEIGHT,
        (boxNetWeight + BOX_WEIGHT).toFixed(3)
      ]);
    }
    if (logRows.length) {
      logSheet.getRange(logSheet.getLastRow() + 1, 1, logRows.length, logRows[0].length).setValues(logRows);
    }

    // NOTE: Box Details / Label HTML are generated entirely client-side
    // (the browser already has generateBoxDetailsHtml/generateLabelHtml
    // and calls them itself) — generating them again here would be pure
    // wasted server CPU on every submission, so we don't.

    // Persist the structured record so every employee can view it later,
    // across logins/devices, including after the invoice number is added.
    const saveRes = saveShipment({
      employee: payload.employee,
      role: payload.role,
      platform: payload.platform,
      poNumber: payload.poNumber,
      invoiceNumber: payload.invoiceNumber || "",
      date: payload.date,
      city: payload.city,
      boxes: payload.boxes
    });
    if (!saveRes.success) {
      return { success: false, message: "Saved log but failed to store shipment record: " + saveRes.message };
    }

    // Push the deduction into Travalate Inventory. This never blocks
    // or rolls back the shipment save — the PO record is the source
    // of truth; if Inventory is unreachable we surface a warning so
    // it can be retried (e.g. by re-saving the shipment from Admin).
    const invSync = syncShipmentInventory_(saveRes.id, payload.boxes, payload.date, payload.employee, payload.platform, payload.city, payload.poNumber, sharedSkuRows);
    const inventoryWarning = !invSync.success
      ? "Inventory sync failed: " + invSync.message
      : invSync.unmapped.length
        ? "Not deducted from Inventory (no SKU mapping): " + invSync.unmapped.join(", ")
        : "";

    // Zepto and Swiggy: silently create a lightweight background invoice
    // record — same RO_INVOICES mechanism Blinkit's RO Invoice feature
    // uses, and the SAME "BLINKIT-SALE" Tally mapping template, just
    // never exposed as a UI feature for either (no Create/Edit RO
    // Invoice buttons, no PDF). It exists purely so the Shipments tab's
    // Tally Excel button has something to read. Uses today's date and
    // the PO Number as its own R.O. Number (mirroring
    // autoCreateRoInvoice_'s existing Blinkit defaults) — invoice number
    // is prefixed "ZI-" (Zepto) or "SW-" (Swiggy) so neither can ever
    // collide with Blinkit's own "SI/2026-27/…" numbering, or with each
    // other. Never blocks or warns on the shipment response if it can't
    // be created (e.g. unmapped SKUs) — Tally Excel just won't be
    // available for that one shipment until the SKU mapping is fixed,
    // same as Blinkit's existing silent-no-op behavior for
    // autoCreateRoInvoice_.
    if (submitPlatform === 'zepto') {
      autoCreateRoInvoice_(saveRes.id, 'ZI-' + (payload.poNumber || '').toString().trim(), payload.employee);
    } else if (submitPlatform === 'swiggy') {
      autoCreateRoInvoice_(saveRes.id, 'SW-' + (payload.poNumber || '').toString().trim(), payload.employee);
    }

    return { success: true, id: saveRes.id, ts: saveRes.ts, inventoryWarning };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── STRUCTURED SHIPMENT STORAGE ────────────────────────────────
// Columns: ID | TIMESTAMP | EMPLOYEE | ROLE | PLATFORM | PO_NUMBER |
//          INVOICE_NUMBER | DATE | CITY | BOXES_JSON | DELETED | EDITED_TS |
//          ADJUSTMENTS_JSON
const SHIP_COLS = {
  ID: 1, TIMESTAMP: 2, EMPLOYEE: 3, ROLE: 4, PLATFORM: 5, PO_NUMBER: 6,
  INVOICE_NUMBER: 7, DATE: 8, CITY: 9, BOXES_JSON: 10, DELETED: 11, EDITED_TS: 12,
  ADJUSTMENTS_JSON: 13
};

function ensureShipmentsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_SHIPMENTS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SHIPMENTS);
    sheet.appendRow([
      "ID","TIMESTAMP","EMPLOYEE","ROLE","PLATFORM","PO_NUMBER",
      "INVOICE_NUMBER","DATE","CITY","BOXES_JSON","DELETED","EDITED_TS","ADJUSTMENTS_JSON"
    ]);
  } else if (sheet.getLastColumn() < SHIP_COLS.ADJUSTMENTS_JSON) {
    // Migration for sheets created before the Adjustment feature existed —
    // just backfill the missing header; existing rows simply read as
    // "no adjustments yet" (blank) until they get their first one.
    sheet.getRange(1, SHIP_COLS.ADJUSTMENTS_JSON).setValue("ADJUSTMENTS_JSON");
  }
  return sheet;
}

/** Parses a shipment row's ADJUSTMENTS_JSON into an array of
 *  { sku, itemCode, qty, employee, ts } entries — each entry is one
 *  Adjustment Block submission's line for one SKU. Multiple entries can
 *  exist for the same SKU if it was adjusted more than once; callers
 *  that need a per-SKU total should sum them. Never throws — returns
 *  [] for blank/invalid JSON (e.g. rows saved before this feature). */
function parseShipmentAdjustments_(rawJson) {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

/** Sums adjustment quantities per SKU from a parsed adjustments array. */
function sumAdjustmentsBySku_(adjustments) {
  const map = {};
  (adjustments || []).forEach(a => {
    const key = String(a.sku || "").trim().toUpperCase();
    if (!key) return;
    map[key] = (map[key] || 0) + (parseInt(a.qty, 10) || 0);
  });
  return map;
}

/** Sums the ORIGINAL (pre-adjustment) packed quantity per SKU from a
 *  shipment's boxes — i.e. exactly what getPackedQtyMapForShipment_
 *  computes client-side, mirrored here server-side for validation. */
function sumPackedBySkuFromBoxes_(boxes) {
  const map = {};
  (boxes || []).forEach(box => {
    (box.items || []).forEach(item => {
      const key = String(item.sku || "").trim().toUpperCase();
      if (!key) return;
      map[key] = (map[key] || 0) + (parseInt(item.qty, 10) || 0);
    });
  });
  return map;
}

/** THE ADJUSTMENT BLOCK — Blinkit-only. Lets an employee record that
 *  fewer units of a SKU actually went out than what was originally
 *  packed/invoiced for this shipment (e.g. a shortage discovered after
 *  the RO Invoice was already generated). Deliberately does NOT touch
 *  BOXES_JSON — the RO Invoice, Tally Excel export, and the PO's own
 *  Remaining-balance tracking all read straight from BOXES_JSON (or the
 *  PO_MASTER sheet, which this never writes to either), so none of them
 *  are affected. The adjustment is purely an additional ledger, visible
 *  only in the Balance popup's "Short" column, and pushed back to
 *  Travalate Inventory as a stock-in so the warehouse's on-hand count
 *  reflects reality again.
 *
 *  adjustments: [{ sku, itemCode, reduceBy }, ...] — reduceBy must be a
 *  positive integer no greater than what's still reducible for that SKU
 *  (originally packed, minus whatever was already adjusted before this
 *  submission). All-or-nothing: if ANY line fails validation, NOTHING
 *  is saved and no Inventory call is made. */
function adjustShipmentQuantities(shipmentId, adjustments, requesterName, requesterRole) {
  try {
    if (!employeeHasModule_(requesterName, requesterRole, "SHIPMENT_ADJUST")) {
      return { success: false, message: "You do not have permission to adjust shipments." };
    }
    if (!Array.isArray(adjustments) || !adjustments.length) {
      return { success: false, message: "No adjustment lines were submitted." };
    }
    const sheet = ensureShipmentsSheet_();
    const data = sheet.getDataRange().getValues();
    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][SHIP_COLS.ID - 1] === shipmentId) { rowIdx = i; break; }
    }
    if (rowIdx === -1) return { success: false, message: "Shipment not found." };
    const row = data[rowIdx];
    if ((row[SHIP_COLS.DELETED - 1] || "") === true || row[SHIP_COLS.DELETED - 1] === "TRUE") {
      return { success: false, message: "This shipment has been deleted." };
    }
    const platform = (row[SHIP_COLS.PLATFORM - 1] || "").toString().trim().toLowerCase();
    if (platform !== "blinkit") {
      return { success: false, message: "The Adjustment Block is only available for Blinkit shipments." };
    }

    let boxes = [];
    try { boxes = JSON.parse(row[SHIP_COLS.BOXES_JSON - 1] || "[]"); } catch (e) { boxes = []; }
    const packedBySku = sumPackedBySkuFromBoxes_(boxes);
    const existingAdjustments = parseShipmentAdjustments_(row[SHIP_COLS.ADJUSTMENTS_JSON - 1]);
    const alreadyAdjustedBySku = sumAdjustmentsBySku_(existingAdjustments);

    // ── Validate every line BEFORE saving anything (all-or-nothing) ──
    const newEntries = [];
    for (const line of adjustments) {
      const skuKey = String(line.sku || "").trim().toUpperCase();
      const reduceBy = parseInt(line.reduceBy, 10) || 0;
      if (!skuKey) return { success: false, message: "An adjustment line is missing its SKU." };
      if (reduceBy <= 0) continue; // zero/blank lines are simply skipped, not errors
      const packed = packedBySku[skuKey] || 0;
      const alreadyAdjusted = alreadyAdjustedBySku[skuKey] || 0;
      const available = packed - alreadyAdjusted;
      if (reduceBy > available) {
        return {
          success: false,
          message: skuKey + ": cannot reduce by " + reduceBy + " — only " + available + " available to adjust (packed " + packed + ", already adjusted " + alreadyAdjusted + ")."
        };
      }
      newEntries.push({
        sku: line.sku,
        itemCode: line.itemCode || "",
        qty: reduceBy,
        employee: requesterName || "",
        ts: new Date().toISOString()
      });
    }
    if (!newEntries.length) {
      return { success: false, message: "Enter at least one quantity to reduce." };
    }

    // ── Save ──
    const updatedAdjustments = existingAdjustments.concat(newEntries);
    sheet.getRange(rowIdx + 1, SHIP_COLS.ADJUSTMENTS_JSON).setValue(JSON.stringify(updatedAdjustments));

    // ── Push the shortage back into Travalate Inventory as a stock-IN,
    //    so the warehouse's on-hand count reflects what actually shipped.
    //    This is intentionally NOT the same "sync" action used for the
    //    original deduction (that action diffs against this shipment's
    //    own last-synced total, and re-running it here would risk the
    //    NEXT real edit re-deducting this same adjustment). It's a
    //    standalone additive stock-in call instead. ──
    const comment = buildShipmentComment_(
      row[SHIP_COLS.PLATFORM - 1], row[SHIP_COLS.CITY - 1], row[SHIP_COLS.PO_NUMBER - 1]
    );
    const invSync = pushAdjustmentToInventory_(shipmentId, newEntries, requesterName, comment);

    return {
      success: true,
      applied: newEntries,
      inventoryWarning: invSync.success ? "" : ("Inventory sync failed: " + invSync.message)
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Standalone additive stock-IN push for the Adjustment Block — resolves
 *  each adjusted SKU to its Travalate Inventory SKU (same mapping
 *  buildInventoryQtyMap_ uses) and sends a positive quantity meaning
 *  "add this many units back."
 *
 *  ⚠️ REQUIRES a corresponding handler on the Travalate Inventory side:
 *  action "adjustmentIn" isn't the same as the existing "sync"/"reverse"
 *  actions Inventory already supports, so this needs a small addition
 *  over there — a simple stock-IN by the given amount per SKU, logging
 *  a cell comment in Inventory's existing manual-entry style (it already
 *  knows how to render "{date} {time} | {employee} | +{qty} (In) |
 *  {comment}" for other +qty/In movements, so this should just be
 *  the same formatting path fed a new source). */
function pushAdjustmentToInventory_(shipmentId, entries, employee, comment) {
  const skuRows = getSkuData();
  const mapBySku = {};
  skuRows.forEach(r => {
    if (r.sku)       mapBySku[String(r.sku).trim().toUpperCase()]       = r.inventorySku;
    if (r.amazonSku) mapBySku[String(r.amazonSku).trim().toUpperCase()] = r.inventorySku;
  });
  const qtyMap = {};
  const unmapped = [];
  entries.forEach(e => {
    const skuKey = String(e.sku).trim().toUpperCase();
    const inventorySku = (mapBySku[skuKey] || "").trim();
    if (!inventorySku) { if (unmapped.indexOf(e.sku) === -1) unmapped.push(e.sku); return; }
    const key = inventorySku.toUpperCase();
    qtyMap[key] = (qtyMap[key] || 0) + (parseInt(e.qty, 10) || 0);
  });
  if (!Object.keys(qtyMap).length) {
    return { success: unmapped.length === 0, message: unmapped.length ? "No Inventory mapping for: " + unmapped.join(", ") : "" };
  }
  const today = new Date().toISOString().split("T")[0];
  const result = callInventoryWebApp_({
    action: "adjustmentIn",
    shipmentId: shipmentId,
    items: qtyMap,
    date: today,
    employee: employee || "",
    comment: comment
  });
  return {
    success: result.success !== false,
    message: result.success === false ? result.error : (unmapped.length ? "No Inventory mapping for: " + unmapped.join(", ") : "")
  };
}

// ════════════════════════════════════════════════════════════════
//  BLINKIT WAREHOUSES
//  Each warehouse also carries its own Consignee + Billed-To details,
//  since these always depend on which warehouse a shipment goes to —
//  NOT a single global value (unlike Seller details, which stay the
//  same regardless of warehouse and live in RO_SETTINGS instead).
// ════════════════════════════════════════════════════════════════
function ensureWarehousesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_WAREHOUSES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_WAREHOUSES);
    sheet.appendRow([
      "NAME", "ADDRESS", "GST_NUMBER",
      "CONSIGNEE_NAME", "CONSIGNEE_GST", "CONSIGNEE_ADDRESS",
      "BILLED_TO_NAME", "BILLED_TO_ADDRESS", "STATE", "ADDRESS_TYPE", "PINCODE",
      "PLATFORMS", "CODE", "WHATSAPP_NUMBER"
    ]);
  } else {
    // Migration: older sheets predate the STATE column (9th), the
    // ADDRESS_TYPE column (10th), the PINCODE column (11th, used by
    // the Tally Excel export's "Address Type" / "Buyer/Supplier -
    // Pincode" columns), the PLATFORMS column (12th, a comma-
    // separated list e.g. "BLINKIT,ZEPTO" — which platform(s) this
    // warehouse should appear under in the New Shipment / PO Upload /
    // Edit Shipment warehouse dropdowns; blank means "show for every
    // platform", so pre-existing warehouses keep working exactly as
    // before until someone explicitly tags them), the CODE column
    // (13th — a short unique warehouse code, e.g. "CHE1", used to tell
    // apart warehouses that legitimately share the same NAME, mainly
    // seen on Swiggy. When CODE is set, "NAME (CODE)" becomes the
    // effective identifier shown/selected everywhere and stored as a
    // shipment's City / a PO's Warehouse value — see getWarehouseByName_
    // for how both the bare and composite forms are matched), and the
    // WHATSAPP_NUMBER column (14th — formerly an optional saved contact
    // number for the Snapshot tab's WhatsApp Share feature, which has
    // since been removed entirely; this column is no longer read or
    // written anywhere and is kept only so existing sheets/column
    // positions aren't disturbed for anyone with data already in it).
    // Add any missing headers so existing warehouses keep working;
    // existing rows simply have a blank value for any newly-added
    // column until edited.
    const lastCol = Math.max(14, sheet.getLastColumn());
    const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const expected = ["NAME","ADDRESS","GST_NUMBER","CONSIGNEE_NAME","CONSIGNEE_GST","CONSIGNEE_ADDRESS","BILLED_TO_NAME","BILLED_TO_ADDRESS","STATE","ADDRESS_TYPE","PINCODE","PLATFORMS","CODE","WHATSAPP_NUMBER"];
    expected.forEach((name, idx) => {
      if ((header[idx] || "").toString().trim().toUpperCase() !== name) {
        sheet.getRange(1, idx + 1).setValue(name);
      }
    });
  }
  return sheet;
}

/** The identifier actually used everywhere a warehouse is selected or
 *  referenced (dropdown option value/label, a shipment's City, a PO's
 *  Warehouse value) — plain NAME when there's no Code, or "NAME (CODE)"
 *  when there is, so warehouses sharing a NAME stay distinguishable and
 *  selectable as genuinely different entities. */
function warehouseDisplayKey_(w) {
  return w.code ? (w.name + " (" + w.code + ")") : w.name;
}

/** Returns every saved Blinkit warehouse, for the City dropdown AND
 *  for looking up Consignee/Billed-To details when generating an RO
 *  Invoice. */
function getBlinkitWarehouses() {
  const sheet = ensureWarehousesSheet_();
  const data = sheet.getDataRange().getValues();
  return data.slice(1)
    .filter(r => r[0])
    .map(r => ({
      name: (r[0]||"").toString().trim(),
      address: (r[1]||"").toString().trim(),
      gst: (r[2]||"").toString().trim(),
      consigneeName: (r[3]||"").toString().trim(),
      consigneeGst: (r[4]||"").toString().trim(),
      consigneeAddress: (r[5]||"").toString().trim(),
      billedToName: (r[6]||"").toString().trim(),
      billedToAddress: (r[7]||"").toString().trim(),
      state: (r[8]||"").toString().trim(),
      addressType: (r[9]||"").toString().trim(),
      pincode: (r[10]||"").toString().trim(),
      // Comma-separated list of platforms this warehouse is mapped to
      // (e.g. ["BLINKIT","ZEPTO"]) — blank/empty means "every platform"
      // for backward compatibility with warehouses saved before this
      // column existed. Client-side dropdowns filter on this.
      platforms: (r[11]||"").toString().split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
      // Short code disambiguating warehouses that share the same NAME
      // (mainly a Swiggy thing) — see warehouseDisplayKey_.
      code: (r[12]||"").toString().trim()
    }));
}

/** Looks up a single warehouse — used when generating an RO Invoice to
 *  pull that shipment's Consignee/Billed-To details from whichever
 *  warehouse its City value matches, and when validating a PO upload's
 *  chosen warehouse exists.
 *
 *  Matches (case-insensitive) against EITHER a warehouse's composite
 *  "NAME (CODE)" key OR its bare NAME, in that order. The composite
 *  match handles every current dropdown selection once a warehouse has
 *  a Code; the bare-NAME fallback keeps every shipment/PO created
 *  BEFORE a Code was ever added to a warehouse resolving correctly —
 *  adding a Code to an existing warehouse later never orphans anything
 *  that already referenced it by its old bare name. */
function getWarehouseByName_(name) {
  const nameTrim = (name || "").toString().trim().toLowerCase();
  if (!nameTrim) return null;
  const all = getBlinkitWarehouses();
  return all.find(w => warehouseDisplayKey_(w).toLowerCase() === nameTrim)
      || all.find(w => w.name.toLowerCase() === nameTrim)
      || null;
}

/** Adds a new Blinkit warehouse, including its Consignee/Billed-To
 *  details and State (used to decide CGST+SGST vs IGST on RO Invoices).
 *
 *  `extra` (optional) = { addressType, pincode, platforms, code } —
 *  addressType is a short free-text label used only in the Tally Excel
 *  export's "Address Type" column (e.g. a short address/pincode
 *  summary); pincode is the warehouse's own PIN code, used in the Tally
 *  Excel export's "Buyer/Supplier - Pincode" column. platforms is an
 *  array of platform keys (e.g. ["blinkit","zepto"]) this warehouse is
 *  mapped to — required, at least one — so the New Shipment / PO
 *  Upload / Edit Shipment warehouse dropdowns only show it under the
 *  platform(s) it actually applies to. addressType/pincode/code stay
 *  optional — left blank if not supplied.
 *
 *  Duplicate handling: a Code, if given, must be globally unique across
 *  every warehouse (case-insensitive) — it's what disambiguates
 *  warehouses that legitimately share the same NAME (seen on Swiggy).
 *  If a Code IS given, the NAME is allowed to repeat (the Code makes it
 *  a distinct, separately-selectable warehouse — see
 *  warehouseDisplayKey_). If NO Code is given, NAME must be unique on
 *  its own, exactly as before this feature existed, so the simple
 *  single-warehouse-per-name case needs no extra steps. */
function addBlinkitWarehouse(name, address, gst, consignee, state, extra, requesterName, requesterRole) {
  try {
    if (!employeeHasModule_(requesterName, requesterRole, "WAREHOUSES")) {
      return { success: false, message: "You do not have permission to add warehouses." };
    }
    const nameTrim = (name || "").toString().trim();
    if (!nameTrim) return { success: false, message: "Warehouse name is required." };
    const c = consignee || {};
    const x = extra || {};
    const stateTrim = (state || "").toString().trim();
    const platforms = Array.isArray(x.platforms) ? x.platforms.map(p => (p||"").toString().trim().toUpperCase()).filter(Boolean) : [];
    const codeTrim = (x.code || "").toString().trim();
    // All fields are mandatory. Consignee/Billed-To values are derived
    // on the client from the four typed fields, so if any is blank here
    // it means a required field was left empty.
    if (!(address || "").toString().trim() ||
        !(gst || "").toString().trim() ||
        !(c.consigneeName || "").toString().trim() ||
        !stateTrim) {
      return { success: false, message: "All fields are required." };
    }
    if (!platforms.length) return { success: false, message: "Select at least one platform this warehouse applies to." };
    const sheet = ensureWarehousesSheet_();
    const data = sheet.getDataRange().getValues();
    if (codeTrim) {
      const codeExists = data.slice(1).some(r => (r[12]||"").toString().trim().toLowerCase() === codeTrim.toLowerCase());
      if (codeExists) return { success: false, message: "A warehouse with Code \"" + codeTrim + "\" already exists." };
    } else {
      const nameExists = data.slice(1).some(r => (r[0]||"").toString().trim().toLowerCase() === nameTrim.toLowerCase());
      if (nameExists) return { success: false, message: "A warehouse named \"" + nameTrim + "\" already exists. If this is a different warehouse that legitimately shares this name, give it a Code to tell them apart." };
    }
    sheet.appendRow([
      nameTrim, (address||"").toString().trim(), (gst||"").toString().trim(),
      (c.consigneeName||"").toString().trim(), (c.consigneeGst||"").toString().trim(), (c.consigneeAddress||"").toString().trim(),
      (c.billedToName||"").toString().trim(), (c.billedToAddress||"").toString().trim(), stateTrim,
      (x.addressType||"").toString().trim(), (x.pincode||"").toString().trim(),
      platforms.join(","), codeTrim, ""
    ]);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Updates an existing warehouse's details (including Consignee/
 *  Billed-To, State, Address Type, Pincode, Platforms, and Code) by
 *  name. Used if these need correcting after the fact — including
 *  attaching a Code to a warehouse that was created before this feature
 *  existed, which is always safe: NAME itself is never touched here, so
 *  every shipment/PO that already referenced this warehouse by its old
 *  bare name keeps resolving correctly (see getWarehouseByName_'s
 *  bare-NAME fallback). */
function updateBlinkitWarehouse(name, fields, requesterName, requesterRole) {
  try {
    if (!employeeHasModule_(requesterName, requesterRole, "WAREHOUSES")) {
      return { success: false, message: "You do not have permission to edit warehouses." };
    }
    const nameTrim = (name || "").toString().trim();
    if (!nameTrim) return { success: false, message: "Warehouse name is required." };
    if (fields.platforms !== undefined) {
      const platforms = Array.isArray(fields.platforms) ? fields.platforms.map(p => (p||"").toString().trim().toUpperCase()).filter(Boolean) : [];
      if (!platforms.length) return { success: false, message: "Select at least one platform this warehouse applies to." };
    }
    const sheet = ensureWarehousesSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if ((data[i][0]||"").toString().trim().toLowerCase() === nameTrim.toLowerCase()) {
        const row = i + 1;
        if (fields.code !== undefined) {
          const codeTrim = (fields.code || "").toString().trim();
          if (codeTrim) {
            const codeExists = data.some((r, ri) => ri !== i && (r[12]||"").toString().trim().toLowerCase() === codeTrim.toLowerCase());
            if (codeExists) return { success: false, message: "A warehouse with Code \"" + codeTrim + "\" already exists." };
          }
        }
        if (fields.address           !== undefined) sheet.getRange(row, 2).setValue(fields.address);
        if (fields.gst               !== undefined) sheet.getRange(row, 3).setValue(fields.gst);
        if (fields.consigneeName     !== undefined) sheet.getRange(row, 4).setValue(fields.consigneeName);
        if (fields.consigneeGst      !== undefined) sheet.getRange(row, 5).setValue(fields.consigneeGst);
        if (fields.consigneeAddress  !== undefined) sheet.getRange(row, 6).setValue(fields.consigneeAddress);
        if (fields.billedToName      !== undefined) sheet.getRange(row, 7).setValue(fields.billedToName);
        if (fields.billedToAddress   !== undefined) sheet.getRange(row, 8).setValue(fields.billedToAddress);
        if (fields.state             !== undefined) sheet.getRange(row, 9).setValue(fields.state);
        if (fields.addressType       !== undefined) sheet.getRange(row, 10).setValue(fields.addressType);
        if (fields.pincode           !== undefined) sheet.getRange(row, 11).setValue(fields.pincode);
        if (fields.platforms         !== undefined) {
          const platforms = Array.isArray(fields.platforms) ? fields.platforms.map(p => (p||"").toString().trim().toUpperCase()).filter(Boolean) : [];
          sheet.getRange(row, 12).setValue(platforms.join(","));
        }
        if (fields.code               !== undefined) sheet.getRange(row, 13).setValue((fields.code||"").toString().trim());
        return { success: true };
      }
    }
    return { success: false, message: "Warehouse not found: " + nameTrim };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ════════════════════════════════════════════════════════════════
//  INVENTORY SNAPSHOT LOG
//  Flat per-day / per-warehouse / per-SKU stock history, built from
//  the daily "Stock On Hand" export (Total Sellable column) that gets
//  uploaded from the Blinkit Shipment Planning tab. Every upload is keyed to
//  the date the person picks, and re-uploading a date simply replaces
//  that date's rows (so a correction just means uploading again).
//  Days nobody uploads are simply absent — nothing to skip, there's
//  just no row for that date.
// ════════════════════════════════════════════════════════════════
function ensureSnapshotSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_SNAPSHOT);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SNAPSHOT);
    sheet.appendRow(["DATE", "WAREHOUSE", "ITEM_ID", "ITEM_NAME", "TOTAL_SELLABLE", "UPLOADED_AT", "UPLOADED_BY", "SOLD_7D", "SOLD_15D", "SOLD_30D", "UPC", "WAREHOUSE_ID"]);
    // Plain-text format on the DATE column so Sheets never silently
    // re-parses "DD-MM-YYYY" into a real Date cell — that auto-conversion
    // is what caused dates to come back as full JS Date strings elsewhere.
    sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat("@");
  } else {
    // One-time self-healing migrations for a sheet created before these
    // columns existed — each appended at the END of the header row (not
    // inserted in the middle) so UPLOADED_AT/UPLOADED_BY and every
    // existing column-index-based read elsewhere stays correct. Existing
    // rows simply read as blank in these new columns.
    const headerLastCol = sheet.getLastColumn();
    const header = headerLastCol > 0 ? sheet.getRange(1, 1, 1, headerLastCol).getValues()[0] : [];
    if (header.indexOf("SOLD_7D") === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1, 1, 3).setValues([["SOLD_7D", "SOLD_15D", "SOLD_30D"]]);
    }
    if (header.indexOf("UPC") === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1, 1, 1).setValues([["UPC"]]);
    }
    if (header.indexOf("WAREHOUSE_ID") === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1, 1, 1).setValues([["WAREHOUSE_ID"]]);
    }
  }
  return sheet;
}

/** Scans the full Snapshot log for SKU x warehouse combinations that
 *  match the pattern reported for TR-2460-Sky-Blue @ Faridabad: the
 *  most recent 3+ logged dates in a row all read 0 stock, right after
 *  a meaningfully positive reading. This only looks at the pattern in
 *  data that's already logged — it can't distinguish a genuine
 *  stockout from a bad import (e.g. the unparseable-number bug fixed
 *  in the upload parser, which used to silently write a false 0
 *  instead of skipping the row) — so it's a "go double-check these"
 *  list for the caller, not a confirmed bug list. Powers the "Check
 *  for Suspicious Zero-Stock" admin panel. */
function findSnapshotZeroDropAnomalies() {
  const MIN_ZERO_RUN = 3;
  const MIN_PRIOR_STOCK = 5; // ignore prior stock too small to be a meaningful baseline
  const LOOKBACK_DATES = 15; // a 3-day zero-streak check never needs more than this many recent dates — bounds the work below regardless of how large the full retention window/log actually is
  const sheet = ensureSnapshotSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { rowsScanned: 0, distinctDates: 0, anomalies: [] };
  // Expected size is roughly (SKUs × warehouses × SNAPSHOT_RETENTION_DAYS)
  // — comfortably under six figures for this project's actual data. A
  // row count far beyond that means something else is wrong (retention
  // pruning not running, a dedup gap, etc.) — better to fail fast with
  // a clear message than silently attempt a read/scan that could take
  // minutes or hit Apps Script's execution limit.
  const ROW_COUNT_SAFETY_CAP = 100000;
  if (lastRow - 1 > ROW_COUNT_SAFETY_CAP) {
    return { rowsScanned: 0, distinctDates: 0, anomalies: [], tooLarge: true, actualRowCount: lastRow - 1 };
  }
  const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues(); // DATE,WAREHOUSE,ITEM_ID,ITEM_NAME,TOTAL_SELLABLE

  // Pass 1 (cheap): which dates exist at all, then keep only the most
  // recent LOOKBACK_DATES of them — every row outside that window gets
  // skipped in pass 2 below, so a log that's grown far larger than the
  // expected ~31-day retention (e.g. from a retention/dedup bug) still
  // scans in bounded time instead of the per-group work scaling with
  // the full log size.
  const allDatesSeen = {};
  data.forEach(function (r) {
    const d = normalizeSnapshotDateCell_(r[0]);
    if (d) allDatesSeen[d] = true;
  });
  const recentDates = {};
  Object.keys(allDatesSeen)
    .sort(function (a, b) { return snapshotSortableDate_(b) - snapshotSortableDate_(a); })
    .slice(0, LOOKBACK_DATES)
    .forEach(function (d) { recentDates[d] = true; });

  const groups = {}; // "warehouse|itemId" -> {warehouse,itemId,itemName,byDate:{date:value}}
  data.forEach(function (r) {
    const date = normalizeSnapshotDateCell_(r[0]);
    if (!recentDates[date]) return;
    const warehouse = String(r[1] || '').trim();
    const itemId = String(r[2] || '').trim();
    const itemName = String(r[3] || '').trim();
    if (!date || !warehouse || !itemId) return;
    const key = warehouse + '|' + itemId;
    if (!groups[key]) groups[key] = { warehouse: warehouse, itemId: itemId, itemName: itemName, byDate: {} };
    const val = Number(r[4]);
    groups[key].byDate[date] = isFinite(val) ? val : 0;
    if (itemName) groups[key].itemName = itemName;
  });

  const results = [];
  Object.keys(groups).forEach(function (key) {
    const g = groups[key];
    const dates = Object.keys(g.byDate).sort(function (a, b) { return snapshotSortableDate_(a) - snapshotSortableDate_(b); }); // ascending
    if (dates.length < MIN_ZERO_RUN + 1) return; // need at least one prior reading plus the zero run
    // Walk backwards from the most recent logged date, counting a
    // trailing run of zeros.
    let zeroStreak = 0, i = dates.length - 1;
    while (i >= 0 && g.byDate[dates[i]] === 0) { zeroStreak++; i--; }
    if (zeroStreak < MIN_ZERO_RUN) return;
    if (i < 0) return; // every logged date is 0 — no positive baseline, so not suspicious, just never stocked
    const lastKnownDate = dates[i], lastKnownStock = g.byDate[lastKnownDate];
    if (lastKnownStock < MIN_PRIOR_STOCK) return;
    results.push({
      warehouse: g.warehouse,
      itemId: g.itemId,
      itemName: g.itemName || g.itemId,
      zeroSince: dates[i + 1],
      zeroDays: zeroStreak,
      lastKnownDate: lastKnownDate,
      lastKnownStock: lastKnownStock
    });
  });
  results.sort(function (a, b) { return b.zeroDays - a.zeroDays || b.lastKnownStock - a.lastKnownStock; });
  return { rowsScanned: data.length, distinctDates: Object.keys(allDatesSeen).length, anomalies: results };
}

function ensureSnapshotDisabledSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_SNAPSHOT_DISABLED);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SNAPSHOT_DISABLED);
    sheet.appendRow(["TYPE", "VALUE", "DISABLED_AT", "DISABLED_BY"]);
  }
  return sheet;
}

/** { warehouses: {name: true}, skus: {itemId: true} } — whatever's
 *  listed here is hidden from getSnapshotMatrix() (and therefore from
 *  the grid, search, and the pre-login public view) until removed. */
function getSnapshotDisabledSets_() {
  const sheet = ensureSnapshotDisabledSheet_();
  const lastRow = sheet.getLastRow();
  const result = { warehouses: {}, skus: {} };
  if (lastRow < 2) return result;
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  data.forEach(function (r) {
    const type = String(r[0]).trim().toUpperCase();
    const value = String(r[1]).trim();
    if (!value) return;
    if (type === "WAREHOUSE") result.warehouses[value] = true;
    else if (type === "SKU") result.skus[value] = true;
  });
  return result;
}

/** Admin-only. Disabling a warehouse or SKU hides it from the
 *  Blinkit Shipment Planning grid and search everywhere until re-enabled —
 *  the underlying logged data is untouched, this only affects what's
 *  displayed. */
function setSnapshotEntityDisabled(adminPin, type, value, disabled) {
  try {
    const employees = getEmployees();
    const admin = employees.find(function (e) {
      return String(e.role || "").toLowerCase() === "admin" &&
        String(e.pin || "").trim() === String(adminPin || "").trim();
    });
    if (!admin) return { success: false, message: "Invalid admin PIN." };

    const typeNorm = String(type || "").trim().toUpperCase();
    if (typeNorm !== "WAREHOUSE" && typeNorm !== "SKU") return { success: false, message: "Invalid type." };
    const valueTrim = String(value || "").trim();
    if (!valueTrim) return { success: false, message: "Missing value." };

    const sheet = ensureSnapshotDisabledSheet_();
    const lastRow = sheet.getLastRow();
    let existingRow = -1;
    if (lastRow > 1) {
      const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]).trim().toUpperCase() === typeNorm && String(data[i][1]).trim() === valueTrim) {
          existingRow = i + 2;
          break;
        }
      }
    }
    if (disabled) {
      if (existingRow === -1) sheet.appendRow([typeNorm, valueTrim, new Date(), admin.name]);
    } else if (existingRow !== -1) {
      sheet.deleteRow(existingRow);
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function ensureSnapshotQtySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_SNAPSHOT_QTY);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SNAPSHOT_QTY);
    sheet.appendRow(["WAREHOUSE", "ITEM_ID", "COL", "VALUE", "UPDATED_AT", "UPDATED_BY"]);
    sheet.hideSheet();
  }
  return sheet;
}

/** Every currently-saved value from the two "Qty to ship" columns —
 *  loaded once when the Blinkit Shipment Planning tab opens, then applied
 *  client-side over the grid (see loadSnapshotQtyValues_ in the HTML).
 *  Flat list rather than a map since Apps Script's JSON bridge handles
 *  arrays of plain objects more predictably than deeply-keyed maps. */
function getSnapshotQtyValues() {
  const sheet = ensureSnapshotQtySheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues(); // WAREHOUSE,ITEM_ID,COL,VALUE
  return data
    .filter(function (r) { return String(r[0]).trim() && String(r[1]).trim() && String(r[2]).trim(); })
    .map(function (r) { return { warehouse: String(r[0]).trim(), itemId: String(r[1]).trim(), col: String(r[2]).trim(), value: String(r[3]) }; });
}

/** Upserts (or, for a blank value, deletes) a single Qty-to-ship cell.
 *  Called from the grid on a short debounce after typing stops — see
 *  scheduleSnapshotQtySave_ in the HTML — so this only fires roughly
 *  once per edit rather than on every keystroke. itemId is "__WH__"
 *  for the freeform cells on the warehouse-name bar itself.
 *
 *  editPin: sent by the pre-login public Blinkit Shipment Planning
 *  view (the PIN verified when editing was unlocked there — see
 *  verifySnapshotEditPin / unlockSnapshotPublicEditing_) and
 *  re-checked here on every single write, not just once at unlock
 *  time — so a disabled Qty input isn't the only thing stopping an
 *  unauthorized edit from that view; someone bypassing the UI and
 *  calling this directly still needs a currently-valid PIN. A call
 *  with no editPin at all is trusted as coming from the already
 *  logged-in, permission-gated tab (the same trust model every other
 *  write endpoint in this app already uses — there's no per-call
 *  session token anywhere in this codebase, only client-side gating,
 *  so this is a meaningful improvement for the public view specifically
 *  rather than a claim of end-to-end server-verified sessions). */
function saveSnapshotQtyValue(warehouse, itemId, col, value, updatedBy, editPin) {
  try {
    if (editPin) {
      const verify = verifySnapshotEditPin(editPin);
      if (!verify.success) return { success: false, message: 'PIN no longer valid — please unlock editing again.' };
    }
    warehouse = String(warehouse || '').trim();
    itemId = String(itemId || '').trim();
    col = String(col || '').trim();
    value = String(value === undefined || value === null ? '' : value);
    if (!warehouse || !itemId || !col) return { success: false, message: 'Missing warehouse/item/column.' };
    const sheet = ensureSnapshotQtySheet_();
    const lastRow = sheet.getLastRow();
    let foundRow = 0;
    if (lastRow >= 2) {
      const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); // WAREHOUSE,ITEM_ID,COL
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]).trim() === warehouse && String(data[i][1]).trim() === itemId && String(data[i][2]).trim() === col) {
          foundRow = i + 2;
          break;
        }
      }
    }
    if (!value.trim()) {
      // Blank value — clearing a cell deletes its row instead of
      // leaving an empty one behind, so the sheet doesn't accumulate
      // dead rows every time someone types then erases a quantity.
      if (foundRow) sheet.deleteRow(foundRow);
      return { success: true };
    }
    const now = new Date();
    if (foundRow) {
      sheet.getRange(foundRow, 4, 1, 3).setValues([[value, now, updatedBy || '']]);
    } else {
      sheet.appendRow([warehouse, itemId, col, value, now, updatedBy || '']);
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── WAREHOUSE APPOINTMENTS PANEL (Snapshot tab side column) ────────
// Scratchpad (Warehouse / Shipping Date / Appt Date) that starts at 5
// rows and grows as the person clicks "+ Add Row" in the HTML — rows
// are addressed by index (0, 1, 2, …), appended to the sheet as needed
// rather than capped at a fixed count. Own sheet, independent of both
// the Qty-to-ship log and the stock snapshot log proper.
var SNAPSHOT_APPT_SHEET_ = 'SNAPSHOT_APPOINTMENTS';
var SNAPSHOT_APPT_MIN_ROWS_ = 5;

function ensureSnapshotApptSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SNAPSHOT_APPT_SHEET_);
  if (!sheet) {
    sheet = ss.insertSheet(SNAPSHOT_APPT_SHEET_);
    sheet.getRange(1, 1, 1, 6).setValues([['ROW_IDX', 'WAREHOUSE', 'SHIPPING_DATE', 'APPT_DATE', 'UPDATED_AT', 'NOTES']]);
    const seedRows = [];
    for (let i = 0; i < SNAPSHOT_APPT_MIN_ROWS_; i++) seedRows.push([i, '', '', '', '', '']);
    sheet.getRange(2, 1, SNAPSHOT_APPT_MIN_ROWS_, 6).setValues(seedRows);
    // The shared Notes text lives once, in row 2's NOTES cell — not
    // per-row — so it isn't duplicated/fragmented across every row.
  }
  return sheet;
}

/** Returns every saved row (padded up to the 5-row minimum even if the
 *  sheet somehow has fewer) plus the shared Notes text. Trailing rows
 *  beyond the 5-row minimum that are completely blank are trimmed off
 *  — e.g. leftover seed rows from an earlier version of this panel
 *  that defaulted to more rows — so a sheet created before the row
 *  count was reduced doesn't keep forcing extra empty rows to show. */
function getSnapshotAppointments() {
  const sheet = ensureSnapshotApptSheet_();
  const lastRow = sheet.getLastRow();
  const rows = [];
  let notes = '';
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    data.forEach(function (r, i) {
      rows.push({ warehouse: String(r[1] || ''), shippingDate: String(r[2] || ''), apptDate: String(r[3] || '') });
      if (i === 0) notes = String(r[5] || '');
    });
  }
  while (rows.length > SNAPSHOT_APPT_MIN_ROWS_) {
    const last = rows[rows.length - 1];
    if (last.warehouse || last.shippingDate || last.apptDate) break;
    rows.pop();
  }
  while (rows.length < SNAPSHOT_APPT_MIN_ROWS_) rows.push({ warehouse: '', shippingDate: '', apptDate: '' });
  return { rows: rows, notes: notes };
}

/** Upserts one cell (Warehouse / Shipping Date / Appt Date) of a row,
 *  addressed by index (0, 1, 2, …) — if rowIdx is past the sheet's
 *  current row count (e.g. a freshly-added "+ Add Row" line, or the
 *  padded rows getSnapshotAppointments backfilled client-side), blank
 *  rows are appended up through it first. Called on a short debounce
 *  after typing stops — see scheduleSnapshotApptCellSave_ in the HTML. */
function saveSnapshotApptCell(rowIdx, field, value) {
  try {
    rowIdx = Number(rowIdx);
    if (isNaN(rowIdx) || rowIdx < 0) return { success: false, message: 'Row out of range.' };
    const colByField = { warehouse: 2, shippingDate: 3, apptDate: 4 };
    const col = colByField[field];
    if (!col) return { success: false, message: 'Unknown field.' };
    const sheet = ensureSnapshotApptSheet_();
    const existingRowCount = sheet.getLastRow() - 1; // data rows only, excluding header
    if (rowIdx >= existingRowCount) {
      const newRows = [];
      for (let i = existingRowCount; i <= rowIdx; i++) newRows.push([i, '', '', '', '', '']);
      sheet.getRange(existingRowCount + 2, 1, newRows.length, 6).setValues(newRows);
    }
    const row = rowIdx + 2;
    sheet.getRange(row, col).setValue(value === undefined || value === null ? '' : String(value));
    sheet.getRange(row, 5).setValue(new Date());
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Deletes one row outright (used for rows beyond the fixed 5 — the
 *  first 5 are only ever cleared in place, never deleted, see
 *  removeOrClearSnapshotApptRow_ in the HTML). Every later row shifts
 *  up by one automatically since rows are addressed by sheet position,
 *  not a stored index. A rowIdx that was never actually persisted
 *  (e.g. a row added client-side via "+ Add Row" but never typed into)
 *  is treated as a harmless no-op rather than an error. */
function deleteSnapshotApptRow(rowIdx) {
  try {
    rowIdx = Number(rowIdx);
    if (isNaN(rowIdx) || rowIdx < 0) return { success: false, message: 'Row out of range.' };
    const sheet = ensureSnapshotApptSheet_();
    const row = rowIdx + 2;
    if (row > sheet.getLastRow()) return { success: true }; // nothing to delete server-side yet
    sheet.deleteRow(row);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Upserts the single shared Notes text (stored once, in row 2's NOTES
 *  cell). Called on a short debounce after typing stops — see
 *  scheduleSnapshotApptNotesSave_ in the HTML. */
function saveSnapshotApptNotes(value) {
  try {
    const sheet = ensureSnapshotApptSheet_();
    sheet.getRange(2, 6).setValue(value === undefined || value === null ? '' : String(value));
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Every distinct warehouse and SKU seen anywhere in the snapshot log,
 *  each flagged with its current enabled/disabled state — powers the
 *  Manage Warehouses & SKUs panel. */
function getSnapshotManageList() {
  const disabled = getSnapshotDisabledSets_();
  const sheet = ensureSnapshotSheet_();
  const lastRow = sheet.getLastRow();
  const warehouses = {}, skus = {};
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 2, lastRow - 1, 3).getValues(); // WAREHOUSE, ITEM_ID, ITEM_NAME
    data.forEach(function (r) {
      const wh = String(r[0]).trim(), id = String(r[1]).trim(), name = String(r[2]).trim();
      if (wh) warehouses[wh] = true;
      if (id && !skus[id]) skus[id] = name || id;
    });
  }
  const warehouseList = Object.keys(warehouses).sort().map(function (w) {
    return { name: w, enabled: !disabled.warehouses[w] };
  });
  const skuList = Object.keys(skus).sort(function (a, b) {
    return (skus[a] || a).localeCompare(skus[b] || b);
  }).map(function (id) {
    return { itemId: id, itemName: skus[id], enabled: !disabled.skus[id] };
  });
  return { warehouses: warehouseList, skus: skuList };
}

/** Cells in the DATE column should always be plain "DD-MM-YYYY" text,
 *  but a handful may already be stored as real Date values (from
 *  before the column was forced to text format) — this normalizes
 *  either shape back to the house date string. */
function normalizeSnapshotDateCell_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "dd-MM-yyyy");
  }
  return (v || "").toString().trim();
}

/** Lets an admin pre-register a warehouse/Item-ID pair (or several Item
 *  IDs at once) that genuinely exists but hasn't shown up in an export
 *  yet — e.g. a warehouse Blinkit just onboarded that nothing's been
 *  sent to, or a SKU that's never shipped to a particular warehouse.
 *  Only the Blinkit Item ID needs to be entered — it's resolved to its
 *  SKU via the SKU Master's BLINKIT_ITEM_ID column, the exact same
 *  identity resolution a real upload goes through (buildSkuIdentityMap_
 *  / resolveSnapshotRowIdentity_) — so the SKU name is what actually
 *  shows in the grid, never the raw Item ID. Appends 0-stock rows dated
 *  to the most recent date already in the log (so they slot straight
 *  into the existing grid instead of creating an orphan date column
 *  that only these entries have data for), rather than a fresh "today"
 *  that may not match what anyone's actually uploaded yet. Deliberately
 *  does NOT go through writeSnapshotRows_ — that function REPLACES
 *  every row on the target date, which would wipe out that whole day's
 *  real data; this only ever appends new rows. */
function addManualSnapshotEntries(adminPin, warehouse, itemIdsRaw) {
  try {
    const employees = getEmployees();
    const admin = employees.find(function (e) {
      return String(e.role || "").toLowerCase() === "admin" && String(e.pin || "").trim() === String(adminPin || "").trim();
    });
    if (!admin) return { success: false, message: "Invalid admin PIN." };

    warehouse = String(warehouse || "").trim();
    if (!warehouse) return { success: false, message: "Warehouse is required." };

    // Accepts Item IDs separated by commas, newlines, or spaces — however
    // someone pastes a list from elsewhere — deduped in case the same ID
    // was entered twice.
    const rawIds = String(itemIdsRaw || "").split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    const itemIds = rawIds.filter(function (id, i) { return rawIds.indexOf(id) === i; });
    if (!itemIds.length) return { success: false, message: "Enter at least one Item ID." };

    const identityMap = buildSkuIdentityMap_();
    const sheet = ensureSnapshotSheet_();
    const lastRow = sheet.getLastRow();
    let targetDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd-MM-yyyy");
    let existingData = [];
    if (lastRow >= 2) {
      existingData = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); // DATE, WAREHOUSE, ITEM_ID
      const dates = existingData.map(function (r) { return normalizeSnapshotDateCell_(r[0]); }).filter(Boolean);
      if (dates.length) {
        dates.sort(function (a, b) { return snapshotSortableDate_(b) - snapshotSortableDate_(a); });
        targetDate = dates[0]; // most recent date already logged, by anyone/any warehouse
      }
    }

    const added = [], skipped = [], newRows = [];
    itemIds.forEach(function (rawId) {
      const r = { itemId: rawId, itemName: "" };
      resolveSnapshotRowIdentity_(r, identityMap); // resolves onto canonical SKU when the Item ID is mapped; keeps raw ID as-is otherwise
      const alreadyExists = existingData.some(function (row) {
        return normalizeSnapshotDateCell_(row[0]) === targetDate && String(row[1]).trim() === warehouse && String(row[2]).trim() === r.itemId;
      });
      if (alreadyExists) { skipped.push(r.itemName || r.itemId); return; }
      newRows.push([targetDate, warehouse, r.itemId, r.itemName || r.itemId, 0, new Date(), (admin.name || "Admin") + " (manual add)"]);
      added.push(r.itemName || r.itemId);
    });

    if (newRows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
    }
    return { success: true, date: targetDate, added: added, skipped: skipped };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Every SKU_MASTER row can be reached by more than one identifier —
 *  BLINKIT_ITEM_ID (numeric, what Blinkit's own exports use) and SKU
 *  (a readable code like "TR-1028-Dark-Green", what the Inventory
 *  Reorder Monitor's exports use). Both point at the same product, so
 *  both get mapped here onto the SAME canonical identity: INVENTORY_SKU
 *  as the key the snapshot log actually stores, and SKU as the display
 *  name. Without this, the same product logged once via each export
 *  would show up as two separate rows and double the warehouse Total. */
function buildSkuIdentityMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SKU);
  const map = {}; // rawId (as typed, trimmed; SKU codes also uppercased) -> {canonicalId, displayName}
  if (!sheet) return map;
  const hm = getSkuHeaderMap_();
  const blinkitIdCol = hm['BLINKIT_ITEM_ID'];
  const skuCol = hm['SKU'] !== undefined ? hm['SKU'] : 1;
  const inventoryCol = hm['INVENTORY_SKU'] !== undefined ? hm['INVENTORY_SKU'] : 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  data.forEach(function (r) {
    const skuCode = (r[skuCol] || "").toString().trim();
    const inventorySku = (r[inventoryCol] || "").toString().trim();
    const canonicalId = inventorySku || skuCode; // fall back to SKU code if INVENTORY_SKU is blank on this row
    const displayName = skuCode || inventorySku;
    if (!canonicalId) return;
    if (blinkitIdCol !== undefined) {
      const blinkitId = (r[blinkitIdCol] || "").toString().trim();
      if (blinkitId) map[blinkitId] = { canonicalId: canonicalId, displayName: displayName };
    }
    if (skuCode) map[skuCode.toUpperCase()] = { canonicalId: canonicalId, displayName: displayName };
  });
  return map;
}

/** Resolves a row's raw itemId (whichever ID system it arrived under)
 *  onto its canonical SKU_MASTER identity, mutating itemId/itemName in
 *  place. Rows with no SKU_MASTER match keep their raw ID as-is. */
function resolveSnapshotRowIdentity_(r, identityMap) {
  const raw = String(r.itemId || "").trim();
  const match = identityMap[raw] || identityMap[raw.toUpperCase()];
  if (match) {
    r.itemId = match.canonicalId;
    r.itemName = match.displayName;
  }
}

/** Replaces every existing row whose DATE matches any date present in
 *  newRows, then appends newRows. Single read + single write regardless
 *  of how many distinct dates are involved, so this stays fast for both
 *  a single day's upload and a multi-thousand-row historical backfill. */
function writeSnapshotRows_(newRows, uploadedBy) {
  const sheet = ensureSnapshotSheet_();
  const identityMap = buildSkuIdentityMap_();
  newRows.forEach(function (r) { resolveSnapshotRowIdentity_(r, identityMap); });

  // Dedupe the incoming batch itself — protects against a source sheet
  // (backfill paste or export) that accidentally has the same
  // date+warehouse+SKU block twice; last occurrence wins.
  const incomingByKey = {};
  newRows.forEach(function (r) {
    incomingByKey[r.date + "|" + r.warehouse + "|" + r.itemId] = r;
  });
  newRows = Object.keys(incomingByKey).map(function (k) { return incomingByKey[k]; });

  const datesToReplace = {};
  newRows.forEach(function (r) { datesToReplace[r.date] = true; });

  const lastRow = sheet.getLastRow();
  let kept = [];
  if (lastRow > 1) {
    const existing = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
    // Dedupe every row already in the sheet by DATE+WAREHOUSE+ITEM_ID,
    // not just the dates this write touches — self-heals any duplicates
    // left over from earlier runs (e.g. before dates were forced to
    // text, a backfill sheet that had a block pasted in twice, or two
    // different exports logging the same product under two different
    // ID systems). Re-resolving identity here means older rows that
    // predate this reconciliation get cleaned up automatically too.
    const keptByKey = {};
    existing.forEach(function (r) {
      const d = normalizeSnapshotDateCell_(r[0]);
      if (datesToReplace[d]) return; // this date is being replaced by the new batch
      const row = { date: d, warehouse: String(r[1]).trim(), itemId: String(r[2]).trim(), itemName: String(r[3]).trim(), totalSellable: r[4] };
      resolveSnapshotRowIdentity_(row, identityMap);
      // r[7..9] = SOLD_7D/15D/30D, r[10] = UPC, r[11] = WAREHOUSE_ID —
      // blank on rows written before these columns existed; carried
      // through as-is either way.
      keptByKey[d + "|" + row.warehouse + "|" + row.itemId] = [row.date, row.warehouse, row.itemId, row.itemName, row.totalSellable, r[5], r[6], r[7], r[8], r[9], r[10], r[11]];
    });
    kept = Object.keys(keptByKey).map(function (k) { return keptByKey[k]; });
  }
  const now = new Date();
  const soldOrBlank_ = function (v) { return (typeof v === "number") ? v : ""; };
  const appended = newRows.map(function (r) {
    return [r.date, r.warehouse, r.itemId, r.itemName, r.totalSellable, now, uploadedBy || "", soldOrBlank_(r.sold7), soldOrBlank_(r.sold15), soldOrBlank_(r.sold30), (r.upc || "").toString().trim(), (r.warehouseId || "").toString().trim()];
  });
  let all = kept.concat(appended);

  // Rolling retention window: keep only the most recent SNAPSHOT_RETENTION_DAYS
  // distinct dates. This is what keeps the log (and every read of it —
  // the grid, the trend chart, the dashboard card) fast indefinitely,
  // rather than growing without bound as more days get uploaded.
  const distinctDates = {};
  all.forEach(function (r) { distinctDates[r[0]] = true; });
  const newestFirst = Object.keys(distinctDates).sort(function (a, b) { return snapshotSortableDate_(b) - snapshotSortableDate_(a); });
  if (newestFirst.length > SNAPSHOT_RETENTION_DAYS) {
    const keepDates = {};
    newestFirst.slice(0, SNAPSHOT_RETENTION_DAYS).forEach(function (d) { keepDates[d] = true; });
    all = all.filter(function (r) { return keepDates[r[0]]; });
  }

  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 12).clearContent();
  if (all.length) {
    sheet.getRange(2, 1, all.length, 1).setNumberFormat("@"); // keep DATE as text, not before setValues re-parses it
    sheet.getRange(2, 1, all.length, 12).setValues(all);
  }
}

/** Called from the Blinkit Shipment Planning tab after the uploaded .xlsx has
 *  already been parsed client-side (SheetJS) into a plain array of
 *  {warehouse, itemId, itemName, totalSellable, sold7, sold15, sold30, upc}
 *  — one per SKU x Warehouse row from the "Stock On Hand" export. The
 *  sold7/15/30 fields come straight from Blinkit's own "Units sold —
 *  Last 7/15/30 days" columns when present (real sales, not inferred
 *  from stock drops) — see snapshotDaAndSod_ for how they're preferred
 *  over the stock-drop inference whenever available. dateStr must be
 *  DD-MM-YYYY (the house date format used everywhere else in this
 *  project). */
function importInventorySnapshot(dateStr, rows, uploadedBy) {
  try {
    if (!dateStr || !/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
      return { success: false, message: "Date must be in DD-MM-YYYY format." };
    }
    if (!rows || !rows.length) {
      return { success: false, message: "No rows to import — check the uploaded file." };
    }
    const newRows = rows.map(function (r) {
      return {
        date: dateStr,
        warehouse: (r.warehouse || "").toString().trim(),
        itemId: (r.itemId || "").toString().trim(),
        itemName: (r.itemName || "").toString().trim(),
        totalSellable: Number(r.totalSellable) || 0,
        sold7: r.sold7 !== undefined && r.sold7 !== "" ? Number(r.sold7) : "",
        sold15: r.sold15 !== undefined && r.sold15 !== "" ? Number(r.sold15) : "",
        sold30: r.sold30 !== undefined && r.sold30 !== "" ? Number(r.sold30) : "",
        upc: (r.upc || "").toString().trim(),
        warehouseId: (r.warehouseId || "").toString().trim()
      };
    }).filter(function (r) { return r.warehouse && r.itemId; });

    if (!newRows.length) {
      return { success: false, message: "None of the rows had both a Warehouse and an Item ID — is this the right sheet?" };
    }
    writeSnapshotRows_(newRows, uploadedBy);
    const warehouses = {};
    newRows.forEach(function (r) { warehouses[r.warehouse] = true; });
    return { success: true, date: dateStr, rowsImported: newRows.length, warehouseCount: Object.keys(warehouses).length };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** One row per date already in the log, with a row count / SKU-total /
 *  warehouse count for each — powers the Dashboard summary card and
 *  the trend chart. Sorted oldest → newest. */
function getSnapshotUploadedDates() {
  const sheet = ensureSnapshotSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues(); // DATE,WAREHOUSE,ITEM_ID,ITEM_NAME,TOTAL_SELLABLE
  const byDate = {};
  data.forEach(function (r) {
    const d = normalizeSnapshotDateCell_(r[0]);
    if (!d) return;
    if (!byDate[d]) byDate[d] = { date: d, rows: 0, total: 0, warehouses: {} };
    byDate[d].rows++;
    byDate[d].total += Number(r[4]) || 0;
    byDate[d].warehouses[r[1]] = true;
  });
  return Object.keys(byDate).map(function (d) {
    return { date: d, rows: byDate[d].rows, total: byDate[d].total, warehouseCount: Object.keys(byDate[d].warehouses).length };
  }).sort(function (a, b) { return snapshotSortableDate_(a.date) - snapshotSortableDate_(b.date); });
}
function snapshotSortableDate_(dmy) {
  const p = dmy.split("-"); // DD-MM-YYYY
  return new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0])).getTime();
}

/** Feeds both the Blinkit Shipment Planning tab's own trend chart and the
 *  small "Latest Stock Snapshot" card on the Dashboard. */
function getSnapshotDashboardSummary() {
  const list = getSnapshotUploadedDates(); // ascending
  if (!list.length) return { hasData: false };
  const last = list[list.length - 1];
  const prev = list.length > 1 ? list[list.length - 2] : null;
  const recent = list.slice(-14); // last 14 uploaded dates, gaps and all
  return {
    hasData: true,
    latestDate: last.date,
    latestTotal: last.total,
    latestWarehouseCount: last.warehouseCount,
    deltaVsPrev: prev ? (last.total - prev.total) : null,
    trend: {
      days: recent.map(function (r) { return r.date; }),
      series: [{ name: "Total Sellable", data: recent.map(function (r) { return r.total; }) }]
    }
  };
}

/** True if this row looks like a warehouse-name header (e.g. "Noida N1
 *  - Feeder") rather than a SKU data row or a stray total/label row.
 *  Header rows have a non-numeric, non-blank first cell and otherwise
 *  contain no numeric data — which is what separates a real header
 *  from the warehouse's own "STOCK OUT DAYS"/"Total" summary row (same
 *  block, but packed with numbers) or a fragment left over from a
 *  wrapped cell when the sheet was pasted in. Comma-formatted numbers
 *  ("1,175") count as numeric here too, since Sheets doesn't always
 *  auto-convert those to a plain number on paste. */
function isSnapshotWarehouseHeaderRow_(row) {
  const first = (row[0] || "").toString().trim();
  if (!first || /^\d+$/.test(first) || /^total$/i.test(first)) return false;
  for (let i = 1; i < row.length; i++) {
    const v = row[i];
    if (v === "" || v === null || v === undefined) continue;
    if (typeof v === "number") return false;
    if (/^-?[\d,]+(\.\d+)?$/.test(String(v).trim())) return false;
  }
  return true;
}

/** Reads one header-row cell into its two raw numeric components plus
 *  year — without yet deciding which component is the day and which
 *  is the month, since that can be ambiguous ("07-01-2026" could be
 *  7 Jan or, read the other way, 1 Jul). Accepts both "/" and "-" as
 *  separators, and an already-Date-typed cell (Sheets sometimes
 *  auto-converts a pasted date-like string). Returns null if the cell
 *  isn't date-like at all. */
function parseSnapshotRawDateCell_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return { a: v.getDate(), b: v.getMonth() + 1, year: v.getFullYear(), resolved: true };
  }
  const s = (v || "").toString().trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  return { a: parseInt(m[1], 10), b: parseInt(m[2], 10), year: parseInt(m[3], 10), resolved: false };
}

/** Parses the wide warehouse-blocks-with-date-columns layout (the same
 *  shape as the historical data pasted into SNAPSHOT_BACKFILL_RAW) into
 *  { 'DD-MM-YYYY': [ {warehouse,itemId,itemName,totalSellable}, ... ] }.
 *  Reads the sheet's own grid (getValues()) rather than raw text, so
 *  column alignment is exact regardless of blank/merged cells — and a
 *  cell that wrapped onto two lines when the data was typed in just
 *  becomes an ordinary extra row that isSnapshotWarehouseHeaderRow_
 *  safely ignores. */
function parseSnapshotBackfillSheet_(sheet) {
  const data = sheet.getDataRange().getValues();

  // Find the header row with the most date-like cells — that's our
  // date row. Collect its raw (unresolved) date cells first; some
  // pasted sheets repeat the same dates twice under two different
  // day/month orderings, which gets sorted out below.
  let dateRowIdx = -1, bestCount = 0, rawCells = [];
  for (let r = 0; r < Math.min(10, data.length); r++) {
    const cells = [];
    for (let c = 0; c < data[r].length; c++) {
      const parsed = parseSnapshotRawDateCell_(data[r][c]);
      if (parsed) cells.push({ col: c, a: parsed.a, b: parsed.b, year: parsed.year, resolved: parsed.resolved });
    }
    if (cells.length > bestCount) { bestCount = cells.length; dateRowIdx = r; rawCells = cells; }
  }
  if (dateRowIdx === -1 || rawCells.length < 3) {
    throw new Error("Could not find a date header row (need at least 3 recognizable dates in one row).");
  }

  // Pass 1: collect "reference months" from every cell that isn't
  // ambiguous — one of its two numbers is > 12 and so can only be the
  // day, forcing the other to be the month. These anchor which
  // month(s) this row's dates actually fall in. Cells Sheets already
  // auto-converted to a Date get the same treatment as text cells here
  // — Sheets' own locale-based guess for an ambiguous date can be
  // wrong in exactly the same way a naive text parse can, so it isn't
  // trusted any more than a plain string is.
  const referenceMonths = {};
  rawCells.forEach(function (cell) {
    if (cell.a > 12 || cell.b > 12) {
      referenceMonths[cell.a > 12 ? cell.b : cell.a] = true;
    }
  });

  // Pass 2: resolve every cell to a canonical "dd-MM-yyyy" key. A
  // genuinely ambiguous cell (both numbers ≤ 12) is read as day-first
  // unless the OTHER reading's month matches a reference month and
  // this one's doesn't — that's what correctly turns "07-01-2026"
  // into 1 Jul (not 7 Jan) when every other column in the row is
  // clearly June/July, and equally corrects a Date cell Sheets itself
  // mis-resolved the same way. Columns that resolve to a date already
  // seen (duplicate data pasted under a different day/month ordering)
  // are dropped — first occurrence wins. "confidence" flags cells
  // where BOTH readings matched a reference month (a genuine coin-flip,
  // e.g. "07-06" vs "06-07" when the row spans both June and July) —
  // those get double-checked against actual row content below, since
  // the header alone can't disambiguate them.
  const seenKeys = {};
  const dateCols = [], dates = [], dateConfidence = {};
  rawCells.forEach(function (cell) {
    let day, month, confidence;
    if (cell.a > 12) {
      day = cell.a; month = cell.b; confidence = "high";
    } else if (cell.b > 12) {
      day = cell.b; month = cell.a; confidence = "high";
    } else {
      const literalMonthOk = referenceMonths[cell.b], swappedMonthOk = referenceMonths[cell.a];
      if (swappedMonthOk && !literalMonthOk) { day = cell.b; month = cell.a; confidence = "high"; }
      else if (literalMonthOk && !swappedMonthOk) { day = cell.a; month = cell.b; confidence = "high"; }
      else { day = cell.a; month = cell.b; confidence = "low"; } // default day-first; genuinely ambiguous
    }
    const key = ("0" + day).slice(-2) + "-" + ("0" + month).slice(-2) + "-" + cell.year;
    if (seenKeys[key]) return;
    seenKeys[key] = true;
    dateCols.push(cell.col);
    dates.push(key);
    dateConfidence[key] = confidence;
  });

  const byDate = {};
  dates.forEach(function (d) { byDate[d] = []; });

  let currentWarehouse = "";
  for (let r = dateRowIdx + 1; r < data.length; r++) {
    const row = data[r];
    const first = (row[0] || "").toString().trim();
    if (!first || /^total$/i.test(first)) continue; // blank separator rows, "STOCK OUT DAYS"/Total summary rows
    if (isSnapshotWarehouseHeaderRow_(row)) {
      currentWarehouse = first;
      continue;
    }
    // A real data row — either a numeric Blinkit Item ID or a SKU code
    // like "TR-1028-Dark-Green" both work as the identifier; whichever
    // it is, writeSnapshotRows_'s SKU_MASTER lookup fills in the
    // canonical display name when it recognizes it.
    const itemId = first;
    dateCols.forEach(function (colIdx, i) {
      const val = row[colIdx];
      if (val === "" || val === null || val === undefined) return; // that date wasn't available for this SKU — skip, don't zero it
      const num = Number(String(val).replace(/,/g, ""));
      if (isNaN(num)) return;
      byDate[dates[i]].push({ warehouse: currentWarehouse, itemId: itemId, itemName: itemId, totalSellable: num });
    });
  }

  // A handful of header cells can be genuinely tied (both the literal
  // and swapped reading land on a valid reference month) and still end
  // up as two different-looking dates that are actually the same
  // upload duplicated — e.g. "07-06-2026" and "06-07-2026" when the
  // row spans both June and July. The header alone can't tell those
  // apart, but identical row content can. Only auto-drop one when the
  // OTHER is provably correct (high confidence, anchored by an
  // unambiguous date elsewhere in the row) — two equally-uncertain
  // ("low" confidence) dates with matching content are left as
  // separate columns rather than guessing which to drop, since a wrong
  // guess there means quietly relabeling a real, correctly-typed date
  // as something else.
  const dateKeysInOrder = dates.filter(function (d) { return byDate[d] !== undefined; });
  const signatureOf = function (rows) {
    return rows.slice()
      .sort(function (a, b) { return (a.warehouse + a.itemId).localeCompare(b.warehouse + b.itemId); })
      .map(function (r) { return r.warehouse + "|" + r.itemId + "|" + r.totalSellable; })
      .join(";");
  };
  const keepForSignature = {};
  dateKeysInOrder.forEach(function (d) {
    const rows = byDate[d];
    if (!rows.length) return;
    const sig = signatureOf(rows);
    const prior = keepForSignature[sig];
    if (!prior) { keepForSignature[sig] = d; return; }
    if (dateConfidence[prior] === "high" && dateConfidence[d] !== "high") return; // prior (provably correct) stays, drop d
    if (dateConfidence[d] === "high" && dateConfidence[prior] !== "high") {
      delete byDate[prior]; // d (provably correct) replaces prior
      keepForSignature[sig] = d;
      return;
    }
    // Both equally confident (both high, or both low) — leave both as
    // separate columns; nothing here justifies picking one over the
    // other.
  });

  return { byDate: byDate, dateConfidence: dateConfidence };
}

/** Wipes every row currently in the snapshot log (keeps the header).
 *  Used by backfillSnapshotFromRawSheet's fullReplace option. */
function clearSnapshotLog_() {
  const sheet = ensureSnapshotSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 12).clearContent();
}

/** Admin-only. Wipes the entire snapshot log with nothing to re-import
 *  — a definitive clean slate, independent of running a backfill. */
function clearSnapshotLogAdmin(adminPin) {
  try {
    const employees = getEmployees();
    const admin = employees.find(function (e) {
      return String(e.role || "").toLowerCase() === "admin" &&
        String(e.pin || "").trim() === String(adminPin || "").trim();
    });
    if (!admin) return { success: false, message: "Invalid admin PIN." };
    clearSnapshotLog_();
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Admin-only, one-time (or occasional) historical import. Paste the
 *  wide warehouse-blocks-with-date-columns data into a tab named
 *  exactly SNAPSHOT_BACKFILL_RAW (regular Ctrl+V paste — let Sheets
 *  auto-split it into columns), then run this once. By default, safe
 *  to re-run: each date it finds simply replaces that date's existing
 *  rows, leaving other dates untouched. Pass fullReplace=true to wipe
 *  the ENTIRE log first instead — use this after fixing a parsing bug,
 *  since a partial merge can't clean up rows under a date key an
 *  earlier (buggy) run mis-resolved and this run doesn't happen to
 *  touch. */
function backfillSnapshotFromRawSheet(adminPin, fullReplace) {
  try {
    const employees = getEmployees();
    const admin = employees.find(function (e) {
      return String(e.role || "").toLowerCase() === "admin" &&
        String(e.pin || "").trim() === String(adminPin || "").trim();
    });
    if (!admin) return { success: false, message: "Invalid admin PIN." };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const raw = ss.getSheetByName(SHEET_SNAPSHOT_RAW);
    if (!raw) {
      return { success: false, message: "No sheet named " + SHEET_SNAPSHOT_RAW + " found. Paste the historical data into a tab with that exact name first, then try again." };
    }
    const parsed = parseSnapshotBackfillSheet_(raw);
    const byDate = parsed.byDate, dateConfidence = parsed.dateConfidence;
    const allRows = [];
    Object.keys(byDate).forEach(function (dateStr) {
      byDate[dateStr].forEach(function (r) {
        allRows.push({ date: dateStr, warehouse: r.warehouse, itemId: r.itemId, itemName: r.itemName, totalSellable: r.totalSellable });
      });
    });
    if (!allRows.length) {
      return { success: false, message: "Found a date header row but no recognizable SKU rows under it — check " + SHEET_SNAPSHOT_RAW + "." };
    }
    if (fullReplace) clearSnapshotLog_();
    writeSnapshotRows_(allRows, admin.name);
    const datesImported = Object.keys(byDate).filter(function (d) { return byDate[d].length; }).sort(function (a, b) { return snapshotSortableDate_(a) - snapshotSortableDate_(b); });
    // Report EVERY date now sitting in the log, not just the ones this
    // run touched — a stale date from an earlier attempt (that this
    // paste doesn't happen to mention) would otherwise stay invisible.
    const allDatesNow = getSnapshotUploadedDates().map(function (r) { return r.date; });
    // Flag any date the header row genuinely couldn't disambiguate on
    // its own (both day-first and month-first readings looked equally
    // valid) — these are worth a manual eyeball, especially since
    // Sheets can silently auto-convert an ambiguous typed date using
    // its own locale guess before this script ever sees the raw text.
    const lowConfidenceDates = datesImported.filter(function (d) { return dateConfidence[d] === "low"; });
    return { success: true, rowsImported: allRows.length, datesImported: datesImported, allDatesInLog: allDatesNow, lowConfidenceDates: lowConfidenceDates };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Same shape as the pasted historical tracker: warehouse blocks, each
 *  with its SKUs as rows and one value per uploaded date. Powers the
 *  grid view on both the logged-in Blinkit Shipment Planning tab and the
 *  read-only pre-login public view (no session needed — this is a
 *  plain read, nothing sensitive). */
/** The snapshot log only ever stores a stock LEVEL per date (Total
 *  Sellable) — there's no separate sales figure in the uploaded Excel.
 *  So "sales" for a given day is inferred as the day-over-day drop in
 *  stock (previous day's stock minus today's), floored at 0 so a
 *  restock day (stock went UP) doesn't register as negative sales.
 *  Returns the per-day inferred-sales series, oldest→newest, one
 *  shorter than the input stock series. */
function snapshotSalesSeriesFromStock_(orderedStockValues) {
  const sales = [];
  for (let i = 1; i < orderedStockValues.length; i++) {
    const diff = orderedStockValues[i - 1] - orderedStockValues[i];
    sales.push(diff > 0 ? diff : 0);
  }
  return sales;
}

/** Daily Average (D/A) = the MAX of the 7/15/30-day average sales,
 *  rounded UP — a conservative read that assumes the SKU is selling at
 *  least this fast. The sales figures themselves come from whichever
 *  source is available: Blinkit's own "Units sold — Last 7/15/30 days"
 *  columns when this warehouse's most recent upload included them
 *  (real sales, not a guess), falling back to the inferred day-over-day
 *  stock-drop calc otherwise (older uploads, or an export variant
 *  without those columns). Stock-Out Days (SOD) = latest stock ÷ D/A,
 *  rounded DOWN, then reduced by however many days have already passed
 *  since the last stock update — the upload a SOD is based on is rarely
 *  from today, so counting from the update date alone would overstate
 *  how many days are actually left as of right now. Never goes below 0
 *  (already due to be out, or already is). Returns { da, sod, daSource }
 *  — sod is null when there's no recent sales velocity to divide by
 *  (can't estimate a stock-out date); daSource is 'reported' or
 *  'inferred', for anyone who wants to know which one produced a
 *  number. */
function snapshotDaAndSod_(orderedStockValues, daysSinceUpdate, directSold) {
  let da, daSource;
  const hasDirectSold = directSold && (
    typeof directSold.sold7 === "number" || typeof directSold.sold15 === "number" || typeof directSold.sold30 === "number"
  );
  if (hasDirectSold) {
    const avg7 = typeof directSold.sold7 === "number" ? directSold.sold7 / 7 : 0;
    const avg15 = typeof directSold.sold15 === "number" ? directSold.sold15 / 15 : 0;
    const avg30 = typeof directSold.sold30 === "number" ? directSold.sold30 / 30 : 0;
    da = Math.max(avg7, avg15, avg30);
    daSource = "reported";
  } else {
    const sales = snapshotSalesSeriesFromStock_(orderedStockValues);
    const avgOfLastN = function (n) {
      if (!sales.length) return 0;
      const slice = sales.slice(-n);
      return slice.length ? slice.reduce(function (a, b) { return a + b; }, 0) / slice.length : 0;
    };
    da = Math.max(avgOfLastN(7), avgOfLastN(15), avgOfLastN(30));
    daSource = "inferred";
  }
  const daRounded = Math.ceil(da);
  const latestStock = orderedStockValues.length ? orderedStockValues[orderedStockValues.length - 1] : 0;
  if (daRounded <= 0) return { da: daRounded, sod: null, daSource: daSource };
  const daysRemainingAsOfUpdate = latestStock / daRounded;
  const daysRemainingAsOfToday = daysRemainingAsOfUpdate - (daysSinceUpdate || 0);
  return { da: daRounded, sod: Math.max(0, Math.floor(daysRemainingAsOfToday)), daSource: daSource };
}

// ── WAREHOUSE BLOCK ORDER (Snapshot grid) ───────────────────────────
// Lets an admin drag-and-drop a whole warehouse's block (header bar +
// SKU rows + Total row) above or below any other warehouse's block in
// the Blinkit Shipment Planning grid — see ensureSnapWarehouseDragListener_ in
// the HTML. Persisted here so the order sticks for every user, not
// just the browser that dragged it, and survives new uploads (which
// only touch the SNAPSHOT log itself, not this).
var SNAPSHOT_WH_ORDER_SHEET_ = 'SNAPSHOT_WAREHOUSE_ORDER';

function ensureSnapshotWarehouseOrderSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SNAPSHOT_WH_ORDER_SHEET_);
  if (!sheet) {
    sheet = ss.insertSheet(SNAPSHOT_WH_ORDER_SHEET_);
    sheet.appendRow(['WAREHOUSE', 'SORT_ORDER']);
  }
  return sheet;
}

/** warehouse name -> sort position (lower = earlier). Warehouses never
 *  explicitly reordered simply won't be in this map — getSnapshotMatrix
 *  keeps those in their original (insertion-order) relative sequence,
 *  appended after every warehouse that DOES have an explicit position. */
function getSnapshotWarehouseOrder_() {
  const sheet = ensureSnapshotWarehouseOrderSheet_();
  const lastRow = sheet.getLastRow();
  const order = {};
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 2).getValues().forEach(function (r) {
      const name = String(r[0] || '').trim();
      if (name) order[name] = Number(r[1]) || 0;
    });
  }
  return order;
}

/** Overwrites the entire saved warehouse order with orderedNames (the
 *  full current display order at the moment of the drag, not just the
 *  two warehouses that moved) — called right after a drag-and-drop
 *  reorder in the HTML. Rewriting the whole small list each time is
 *  simpler and safer than patching individual rows, and there's never
 *  more than a few dozen warehouses. */
function saveSnapshotWarehouseOrder(orderedNames) {
  try {
    const sheet = ensureSnapshotWarehouseOrderSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 2).clearContent();
    const rows = (orderedNames || [])
      .map(function (name, i) { return [String(name || '').trim(), i]; })
      .filter(function (r) { return r[0]; });
    if (rows.length) sheet.getRange(2, 1, rows.length, 2).setValues(rows);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function getSnapshotMatrix() {
  const sheet = ensureSnapshotSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { dates: [], warehouses: [] };
  const data = sheet.getRange(2, 1, lastRow - 1, 12).getValues(); // DATE,WAREHOUSE,ITEM_ID,ITEM_NAME,TOTAL_SELLABLE,UPLOADED_AT,UPLOADED_BY,SOLD_7D,SOLD_15D,SOLD_30D,UPC,WAREHOUSE_ID
  const disabled = getSnapshotDisabledSets_();

  const dateSet = {};
  const whMap = {}; // warehouse -> { itemId -> {itemId,itemName,values:{date:val},sold:{date:{sold7,sold15,sold30}},upc} } — plain-object key order is insertion order, so warehouses come out in the same order they were written (matching the original pasted block order)
  const whIdMap = {}; // warehouse name -> Blinkit's own numeric Warehouse Facility ID (first non-blank wins — it's a fixed attribute per warehouse, not per-day)
  data.forEach(function (r) {
    const date = normalizeSnapshotDateCell_(r[0]), warehouse = String(r[1]).trim(), itemId = String(r[2]).trim(),
      itemName = String(r[3]).trim(), val = Number(r[4]) || 0;
    if (!date || !warehouse || !itemId) return;
    if (disabled.warehouses[warehouse] || disabled.skus[itemId]) return;
    dateSet[date] = true;
    if (!whMap[warehouse]) whMap[warehouse] = {};
    if (!whMap[warehouse][itemId]) whMap[warehouse][itemId] = { itemId: itemId, itemName: itemName, values: {}, sold: {}, upc: "" };
    if (itemName) whMap[warehouse][itemId].itemName = itemName;
    whMap[warehouse][itemId].values[date] = val;
    // r[7..9] = SOLD_7D/15D/30D — blank ("") on rows from before this
    // column existed, or from an export variant that doesn't have it;
    // kept as-is (not coerced to 0) so snapshotDaAndSod_ can tell
    // "genuinely reported zero" apart from "no data here at all".
    whMap[warehouse][itemId].sold[date] = {
      sold7: typeof r[7] === "number" ? r[7] : null,
      sold15: typeof r[8] === "number" ? r[8] : null,
      sold30: typeof r[9] === "number" ? r[9] : null
    };
    // UPC and Warehouse ID are fixed attributes, not per-day values —
    // the first non-blank one we see is as good as any other.
    if (!whMap[warehouse][itemId].upc && r[10]) whMap[warehouse][itemId].upc = String(r[10]).trim();
    if (!whIdMap[warehouse] && r[11]) whIdMap[warehouse] = String(r[11]).trim();
  });

  const dates = Object.keys(dateSet).sort(function (a, b) { return snapshotSortableDate_(a) - snapshotSortableDate_(b); });
  const warehouses = Object.keys(whMap).map(function (wh) {
    const skuList = Object.keys(whMap[wh]).map(function (id) { return whMap[wh][id]; });
    // Which dates actually have SOME row logged for this warehouse — a
    // SKU missing on one of THOSE dates almost always means it dropped
    // out of that day's export because it hit zero stock, so it's safe
    // to show 0 rather than blank. A date the whole warehouse has no
    // data for at all is a genuine gap (e.g. that day's file was never
    // uploaded) and stays blank — we don't actually know it was zero.
    const datesWithDataForWh = {};
    skuList.forEach(function (sku) {
      Object.keys(sku.values).forEach(function (d) { datesWithDataForWh[d] = true; });
    });
    skuList.forEach(function (sku) {
      Object.keys(datesWithDataForWh).forEach(function (d) {
        if (sku.values[d] === undefined) sku.values[d] = 0;
      });
    });
    // D/A (Daily Average) and SOD (Stock-Out Days) per SKU, using only
    // this warehouse's own date coverage (whDates), oldest→newest —
    // `dates` is the already-sorted global date list from above, so
    // filtering it keeps chronological order without re-sorting.
    const whDates = dates.filter(function (d) { return datesWithDataForWh[d]; });
    // How many days have passed between this warehouse's last actual
    // stock update and today — SOD needs this to count down from NOW,
    // not from whenever the last upload happened to be.
    let daysSinceUpdate = 0;
    if (whDates.length) {
      const today = new Date();
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const lastUpdateMs = snapshotSortableDate_(whDates[whDates.length - 1]);
      daysSinceUpdate = Math.max(0, Math.round((todayMidnight - lastUpdateMs) / 86400000));
    }
    const latestDate = whDates.length ? whDates[whDates.length - 1] : null;
    skuList.forEach(function (sku) {
      const ordered = whDates.map(function (d) { return sku.values[d]; });
      const directSold = latestDate ? sku.sold[latestDate] : null;
      const daSod = snapshotDaAndSod_(ordered, daysSinceUpdate, directSold);
      sku.da = daSod.da;
      sku.sod = daSod.sod;
      sku.daSource = daSod.daSource; // 'reported' (Blinkit's own sold figures) or 'inferred' (stock-drop estimate)
      delete sku.sold; // internal-only, not needed by the client
    });
    const skus = skuList.sort(function (a, b) {
      if (b.da !== a.da) return b.da - a.da; // largest Daily Average first
      return (a.itemName || a.itemId).localeCompare(b.itemName || b.itemId);
    });
    return { name: wh, skus: skus, warehouseId: whIdMap[wh] || "" };
  });
  // Apply any saved drag-and-drop order (see saveSnapshotWarehouseOrder)
  // — warehouses with an explicit saved position sort by it; any
  // warehouse never explicitly reordered (including a brand-new one
  // from today's upload) keeps its original insertion-order position
  // relative to other un-ordered warehouses, appended after every
  // explicitly-ordered one.
  const savedOrder = getSnapshotWarehouseOrder_();
  if (Object.keys(savedOrder).length) {
    const insertionIndex = {};
    warehouses.forEach(function (w, i) { insertionIndex[w.name] = i; });
    warehouses.sort(function (a, b) {
      const oa = savedOrder.hasOwnProperty(a.name) ? savedOrder[a.name] : null;
      const ob = savedOrder.hasOwnProperty(b.name) ? savedOrder[b.name] : null;
      if (oa !== null && ob !== null) return oa - ob;
      if (oa !== null) return -1;
      if (ob !== null) return 1;
      return insertionIndex[a.name] - insertionIndex[b.name];
    });
  }
  return { dates: dates, warehouses: warehouses };
}

// ════════════════════════════════════════════════════════════════
//  RO INVOICE — SELLER SETTINGS (one-time, admin-edit)
//  Seller details stay the same regardless of which warehouse a
//  shipment goes to, unlike Consignee/Billed-To (which live per
//  warehouse instead — see BLINKIT WAREHOUSES above).
// ════════════════════════════════════════════════════════════════
const RO_SETTINGS_FIELDS = ["SELLER_NAME", "SELLER_GST", "SELLER_ADDRESS"];

function ensureRoSettingsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_RO_SETTINGS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_RO_SETTINGS);
    sheet.appendRow(["FIELD", "VALUE"]);
    RO_SETTINGS_FIELDS.forEach(f => sheet.appendRow([f, ""]));
    sheet.hideSheet();
  }
  return sheet;
}

/** Returns the current Seller settings as a flat object, e.g.
 *  { sellerName: "...", sellerGst: "...", sellerAddress: "..." }.
 *  Visible to everyone (read-only for non-admins, enforced
 *  client-side same as other admin-gated screens — see
 *  updateRoSettings for the actual write-side guard). */
function getRoSettings() {
  const sheet = ensureRoSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  const map = {};
  data.slice(1).forEach(r => { map[r[0]] = r[1] || ""; });
  return {
    sellerName: map["SELLER_NAME"] || "",
    sellerGst: map["SELLER_GST"] || "",
    sellerAddress: map["SELLER_ADDRESS"] || ""
  };
}

/** Updates the Seller settings. Admin-only — verified via PIN, same
 *  pattern as other admin-gated actions elsewhere in this project
 *  (the client never trusts its own role flag for a write like this;
 *  the PIN is re-checked here). */
function updateRoSettings(adminPin, settings) {
  try {
    const employees = getEmployees();
    const admin = employees.find(e =>
      String(e.role || "").toLowerCase() === "admin" &&
      String(e.pin || "").trim() === String(adminPin || "").trim()
    );
    if (!admin) return { success: false, message: "Invalid admin PIN." };

    const sheet = ensureRoSettingsSheet_();
    const data = sheet.getDataRange().getValues();
    const rowByField = {};
    for (let i = 1; i < data.length; i++) rowByField[data[i][0]] = i + 1;

    const writes = {
      SELLER_NAME: settings.sellerName, SELLER_GST: settings.sellerGst, SELLER_ADDRESS: settings.sellerAddress
    };
    Object.keys(writes).forEach(field => {
      if (writes[field] === undefined) return;
      const row = rowByField[field];
      if (row) sheet.getRange(row, 2).setValue(writes[field]);
    });
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** The "Create RO Invoice" button only appears on shipments created
 *  AFTER this feature was first deployed — never retroactively on
 *  older shipments. Rather than requiring you to pick and hard-code a
 *  date, the cutoff is captured automatically: the very first time
 *  this function runs in production, it stamps "right now" as the
 *  permanent cutoff and never changes it again. Every call after that
 *  just returns the already-stored value. */
// Fixed cutoff for RO Invoice eligibility — only shipments created on or
// after this exact moment are eligible. This used to be set dynamically
// ("the first time this code ever runs, stamp right now"), but that was
// a real bug: the cutoff only got stamped at the moment someone actually
// clicked "Create RO Invoice," which is always AFTER the shipment itself
// was created — so literally the first-ever click was guaranteed to
// fail, no matter how recently the shipment was made. A fixed, hardcoded
// timestamp avoids that timing trap entirely.
const RO_ELIGIBILITY_CUTOFF = new Date("2026-06-30T11:45:33.000Z");

function ensureRoEligibilityCutoff_() {
  return RO_ELIGIBILITY_CUTOFF;
}

// ════════════════════════════════════════════════════════════════
//  RO INVOICES — one row per shipment that has had an RO Invoice
//  created. Enforces: (1) only ONE RO Invoice per shipment, ever,
//  (2) RO Invoice Numbers are globally unique — checked against both
//  other RO Invoices AND every regular shipment's own Invoice Number,
//  since both are "an invoice number" in the same numbering universe
//  even though they're stored in different sheets.
// ════════════════════════════════════════════════════════════════
const RO_COLS = {
  SHIPMENT_ID: 1, RO_INVOICE_NUMBER: 2, RO_NUMBER: 3, INVOICE_DATE: 4,
  DELIVERY_DATE: 5, EWAY_BILL_NUMBER: 6, DELIVERY_PARTNER: 7,
  CREATED_BY: 8, CREATED_TS: 9
};

function ensureRoInvoicesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_RO_INVOICES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_RO_INVOICES);
    sheet.appendRow([
      "SHIPMENT_ID", "RO_INVOICE_NUMBER", "RO_NUMBER", "INVOICE_DATE",
      "DELIVERY_DATE", "EWAY_BILL_NUMBER", "DELIVERY_PARTNER",
      "CREATED_BY", "CREATED_TS"
    ]);
  }
  return sheet;
}

/** True if this shipment already has an RO Invoice (enforces "one
 *  ever" — once created, the button/flow should be treated as already
 *  used for that shipment). */
function shipmentHasRoInvoice_(shipmentId) {
  const sheet = ensureRoInvoicesSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const ids = sheet.getRange(2, RO_COLS.SHIPMENT_ID, lastRow - 1, 1).getValues();
  return ids.some(r => r[0] === shipmentId);
}

/** Checks an RO Invoice Number for uniqueness against BOTH existing RO
 *  Invoices and every regular shipment's own Invoice Number field —
 *  these are both "invoice numbers" in the same real-world numbering
 *  space, so a collision between the two would be just as much a
 *  problem as a collision within RO Invoices alone. */
function ensureCancelledInvoicesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_CANCELLED_INVOICES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_CANCELLED_INVOICES);
    sheet.appendRow(["INVOICE_NUMBER", "SHIPMENT_ID", "REASON", "CANCELLED_AT", "CANCELLED_BY"]);
  }
  return sheet;
}

/** Records that an invoice number is no longer attached to the
 *  shipment it was on — either because that shipment was deleted
 *  entirely (reason "SHIPMENT_DELETED"), or because an RO Invoice edit
 *  moved that shipment onto a different number (reason
 *  "RO_INVOICE_EDITED"). Whether this actually BLOCKS the number from
 *  being reused elsewhere depends on which of those two reasons it
 *  was — see isInvoiceNumberCancelled_. No-op if the number is blank
 *  or this exact (number, reason) combination is already recorded. */
function recordCancelledInvoiceNumber_(invoiceNumber, shipmentId, reason, cancelledBy) {
  const trim = (invoiceNumber || "").toString().trim();
  if (!trim) return;
  if (isInvoiceNumberCancelled_(trim)) return; // already permanently blocked — no need to log again
  const sheet = ensureCancelledInvoicesSheet_();
  sheet.appendRow([trim, shipmentId || "", reason || "", new Date(), cancelledBy || ""]);
}

/** True if this invoice number has ever been superseded by an RO
 *  Invoice EDIT — used everywhere an invoice number's uniqueness gets
 *  checked, so a superseded number is treated exactly like one that's
 *  already in active use.
 *
 *  Deliberately does NOT block a number that was voided purely by a
 *  shipment DELETE (see the REASON column, recorded by
 *  recordCancelledInvoiceNumber_) — once the shipment that used it is
 *  gone entirely, nothing in the system still references that number,
 *  so re-issuing it is safe. This matters most for the common
 *  "created the wrong shipment, deleted it, recreated it correctly
 *  with the same PO" correction — the person naturally wants to reuse
 *  the same invoice number, not skip it forever. An EDITED number is
 *  different and stays blocked: the ORIGINAL shipment is still active,
 *  just now under a NEW number, so letting the old one be reused
 *  elsewhere risks two different documents ever sharing one number. */
function isInvoiceNumberCancelled_(invoiceNumber) {
  const trim = (invoiceNumber || "").toString().trim().toLowerCase();
  if (!trim) return false;
  const sheet = ensureCancelledInvoicesSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const values = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); // INVOICE_NUMBER, SHIPMENT_ID, REASON
  for (const r of values) {
    if ((r[0] || "").toString().trim().toLowerCase() !== trim) continue;
    const reason = (r[2] || "").toString().trim().toUpperCase();
    if (reason !== "SHIPMENT_DELETED") return true; // still permanently blocked (e.g. RO_INVOICE_EDITED)
  }
  return false; // every recorded cancellation of this number was a plain delete — safe to reuse
}

/** Admin-only: every invoice number that's STILL actually blocking reuse
 *  right now (i.e. excludes plain SHIPMENT_DELETED rows, which already
 *  don't block anything — see isInvoiceNumberCancelled_ above) so the
 *  Admin tab's list only shows numbers someone might genuinely want
 *  restored, not routine delete history. Newest first. */
function getCancelledInvoiceNumbers() {
  const sheet = ensureCancelledInvoicesSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const out = [];
  values.forEach(r => {
    const invoiceNumber = (r[0] || "").toString().trim();
    const reason = (r[2] || "").toString().trim().toUpperCase();
    if (!invoiceNumber || reason === "SHIPMENT_DELETED") return;
    out.push({
      invoiceNumber: invoiceNumber,
      shipmentId: r[1] || "",
      reason: reason,
      cancelledAt: r[3] ? toDateString_(r[3]) : "",
      cancelledBy: r[4] || ""
    });
  });
  out.reverse();
  return out;
}

/** Admin-only: removes every recorded block on this exact invoice
 *  number, freeing it up for reuse on a different shipment. Deliberately
 *  clears ALL matching rows (not just the newest), so a number blocked
 *  more than once in its history is fully unblocked, not just partially.
 *  Re-checked server-side against the live EMPLOYEES sheet — the
 *  client's claimed role is never trusted for this, same pattern as
 *  deleteShipmentRecord. */
function restoreCancelledInvoiceNumber(invoiceNumber, requesterName, requesterRole) {
  try {
    if (!isRequesterAdmin_(requesterName)) {
      return { success: false, message: "Only an admin can restore a cancelled invoice number." };
    }
    const trim = (invoiceNumber || "").toString().trim().toLowerCase();
    if (!trim) return { success: false, message: "Missing invoice number." };
    const sheet = ensureCancelledInvoicesSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true };
    const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = values.length - 1; i >= 0; i--) {
      if ((values[i][0] || "").toString().trim().toLowerCase() === trim) {
        sheet.deleteRow(i + 2);
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function findDuplicateRoInvoiceNumber_(roInvoiceNumber, excludeShipmentId) {
  const trim = (roInvoiceNumber || "").toString().trim().toLowerCase();
  if (!trim) return false;

  if (isInvoiceNumberCancelled_(roInvoiceNumber)) return true; // permanently voided — no exclusion, not even for its original shipment

  const roSheet = ensureRoInvoicesSheet_();
  const roLastRow = roSheet.getLastRow();
  if (roLastRow >= 2) {
    const rows = roSheet.getRange(2, 1, roLastRow - 1, RO_COLS.RO_INVOICE_NUMBER).getValues();
    for (const r of rows) {
      // Skip this shipment's OWN RO row — otherwise editing an RO
      // Invoice (keeping the same number) or syncing the unified number
      // would falsely flag the shipment against itself.
      if (excludeShipmentId && r[RO_COLS.SHIPMENT_ID - 1] === excludeShipmentId) continue;
      if ((r[RO_COLS.RO_INVOICE_NUMBER - 1] || "").toString().trim().toLowerCase() === trim) return true;
    }
  }

  // Also unique against SHIPMENTS' invoice numbers — but exclude this
  // shipment's own row, since the unified invoice number is stored on
  // BOTH the shipment and its RO Invoice (same value, same shipment).
  const dup = findDuplicateShipmentField_(null, roInvoiceNumber, excludeShipmentId || null);
  return !!dup.invoiceDuplicate;
}

/** Returns the RO Invoice row for a shipment, if one exists (used to
 *  show "already created" state / let the employee re-download the
 *  same PDF rather than re-enter everything). */
function getRoInvoiceForShipment(shipmentId) {
  const sheet = ensureRoInvoicesSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][RO_COLS.SHIPMENT_ID - 1] === shipmentId) {
      const rawEway = data[i][RO_COLS.EWAY_BILL_NUMBER - 1];
      const rawDp = data[i][RO_COLS.DELIVERY_PARTNER - 1];
      return {
        roInvoiceNumber: data[i][RO_COLS.RO_INVOICE_NUMBER - 1],
        roNumber: data[i][RO_COLS.RO_NUMBER - 1],
        invoiceDate: data[i][RO_COLS.INVOICE_DATE - 1],
        deliveryDate: data[i][RO_COLS.DELIVERY_DATE - 1],
        // Always strings — Sheets stores a purely-numeric E-way Bill
        // Number cell as a number type, and every caller of this
        // function eventually feeds it into client code (.replace(),
        // string concatenation for the PDF) that assumes text.
        ewayBillNumber: (rawEway === undefined || rawEway === null) ? "" : String(rawEway),
        deliveryPartner: (rawDp === undefined || rawDp === null) ? "" : String(rawDp)
      };
    }
  }
  return null;
}

/** Core RO Invoice creation function. Validates everything, computes
 *  the full aggregated/tax-calculated row data, writes the RO_INVOICES
 *  record, and returns everything the client needs to render the PDF
 *  (so the client never has to re-derive the math itself).
 *
 *  params = {
 *    shipmentId, roInvoiceNumber, roNumber, invoiceDate, deliveryDate,
 *    ewayBillNumber, deliveryPartner, employee
 *  }
 *  All fields are REQUIRED — every one is validated below.
 */
/** RO Invoice / Tally Excel eligibility and field resolution is shared
 *  across Blinkit (full UI feature), Zepto, and Swiggy (both of which
 *  only ever reach this silently via autoCreateRoInvoice_, backing
 *  their Tally Excel export — no Create/Edit RO Invoice buttons for
 *  either). Single place mapping platform → its own SKU_MASTER
 *  item-id/landing-price column, so every caller stays generic instead
 *  of repeating a platform ternary that's easy to forget to extend when
 *  a new PO-driven platform is added. */
function roFieldsForPlatform_(platform) {
  const p = (platform || '').toString().trim().toLowerCase();
  // upcField points at the SAME getSkuData() field the UPC-adding tool
  // (addUpc) writes into for that platform — i.e. the live, current UPC
  // on file in SKU_MASTER, not whatever was snapshotted onto a box item
  // back when the shipment was first entered.
  if (p === 'zepto')  return { itemIdField: 'zeptoItemId',  landingPriceField: 'zeptoLandingPrice',  upcField: 'zepto' };
  if (p === 'swiggy') return { itemIdField: 'swiggyItemId', landingPriceField: 'swiggyLandingPrice', upcField: 'swiggy' };
  return { itemIdField: 'blinkitItemId', landingPriceField: 'blinkitLandingPrice', upcField: 'blinkit' };
}

/** Shared validation + aggregation logic used by both getRoEligibility()
 *  (a lightweight pre-check the client calls BEFORE showing the manual
 *  entry form, so unmapped SKUs are caught early) and createRoInvoice()
 *  itself (which reuses this exact same result rather than recomputing
 *  it, so the two can never disagree).
 *
 *  Returns either { success:false, ... } for any blocking condition, or
 *  { success:true, shipmentRow, agg, skuByCode } with everything the
 *  caller needs to proceed. */
function checkRoEligibility_(shipmentId, opts) {
  opts = opts || {};
  const shSheet = ensureShipmentsSheet_();
  const shData = shSheet.getDataRange().getValues();
  let shipmentRow = null;
  for (let i = 1; i < shData.length; i++) {
    if (shData[i][SHIP_COLS.ID - 1] === shipmentId) { shipmentRow = shData[i]; break; }
  }
  if (!shipmentRow) return { success: false, message: "Shipment not found." };

  const platform = String(shipmentRow[SHIP_COLS.PLATFORM - 1] || "").trim().toLowerCase();
  // Blinkit's RO Invoice is a full user-facing feature; Zepto and Swiggy
  // never expose RO Invoice/Tally Excel buttons in the UI at all — their
  // shipments only ever reach this via autoCreateRoInvoice_, called
  // silently from submitShipment purely to back the Tally Excel export.
  // All three still share this exact same eligibility/aggregation logic,
  // just keyed to each platform's own SKU_MASTER item-id column — see
  // roFieldsForPlatform_.
  const roFields = roFieldsForPlatform_(platform);
  const roItemIdField = roFields.itemIdField;
  const roLandingPriceField = roFields.landingPriceField;
  if (!poPlatformConfig_(platform)) {
    return { success: false, message: "RO Invoice is only available for Blinkit/Zepto/Swiggy shipments." };
  }

  const createdTs = shipmentRow[SHIP_COLS.TIMESTAMP - 1];
  const cutoff = ensureRoEligibilityCutoff_();
  if (!(createdTs instanceof Date) || createdTs < cutoff) {
    return { success: false, message: "This shipment was created before RO Invoice support was added, so it isn't eligible." };
  }

  // When editing an existing RO Invoice (allowExisting), skip the
  // "only one per shipment" guard — we WANT to operate on the existing one.
  if (!opts.allowExisting && shipmentHasRoInvoice_(shipmentId)) {
    return { success: false, message: "This shipment already has an RO Invoice. Only one can ever be created per shipment." };
  }

  let boxes = [];
  try { boxes = JSON.parse(shipmentRow[SHIP_COLS.BOXES_JSON - 1] || "[]"); } catch (e) { boxes = []; }
  if (!boxes.length) return { success: false, message: "This shipment has no boxes." };

  const skuRows = getSkuData();
  const skuByCode = {};
  skuRows.forEach(r => {
    if (r.sku) skuByCode[r.sku.toUpperCase()] = r;
    if (r.amazonSku) skuByCode[r.amazonSku.toUpperCase()] = r;
  });

  const agg = {};
  boxes.forEach(box => {
    (box.items || []).forEach(item => {
      const key = String(item.sku).trim().toUpperCase();
      if (!agg[key]) agg[key] = { sku: item.sku, upc: item.upc, boxNumbers: new Set(), totalQty: 0, perBoxQty: [] };
      agg[key].boxNumbers.add(box.boxNumber);
      agg[key].totalQty += (parseInt(item.qty, 10) || 0);
      agg[key].perBoxQty.push(parseInt(item.qty, 10) || 0);
    });
  });

  const unmapped = [];
  Object.values(agg).forEach(a => {
    const master = skuByCode[String(a.sku).trim().toUpperCase()];
    if (!master || !master[roItemIdField] || !master.mrp || !master.hsn || !master.tax || !master[roLandingPriceField]) {
      unmapped.push(a.sku);
    }
  });
  if (unmapped.length) {
    return { success: false, unmapped: true, unmappedSkus: unmapped,
      message: "The following SKU(s) are not fully mapped for RO Invoice (Item ID / MRP / HSN / Tax / Landing Price): " + unmapped.join(", ") };
  }

  return { success: true, shipmentRow, agg, skuByCode, itemIdField: roItemIdField, landingPriceField: roLandingPriceField, upcField: roFields.upcField };
}

/** Lightweight check the client calls BEFORE showing the manual-entry
 *  form — catches "not Blinkit", "not eligible", "already has an RO
 *  Invoice", and "unmapped SKUs" early, so an employee never fills in
 *  all 6 required fields only to be blocked at the very end. */
function getRoEligibility(shipmentId) {
  const result = checkRoEligibility_(shipmentId);
  if (!result.success) return result;
  return { success: true };
}

/** Shared row-building + reverse tax-math logic, used by both
 *  createRoInvoice() (first creation) and redownloadRoInvoice()
 *  (regenerating an already-created invoice's PDF later) — so both
 *  always compute identical numbers from the same shipment data. */
function buildRoInvoiceRows_(agg, skuByCode, itemIdField, landingPriceField, upcField) {
  itemIdField = itemIdField || 'blinkitItemId';
  landingPriceField = landingPriceField || 'blinkitLandingPrice';
  let grossTotal = 0, igstTotal = 0, finalTotal = 0, totalBoxesSum = 0, totalUnitsSum = 0;
  const rows = Object.values(agg).map(a => {
    const master = skuByCode[String(a.sku).trim().toUpperCase()];
    const boxCount = a.boxNumbers.size;
    const isEven = a.perBoxQty.every(q => q === a.perBoxQty[0]);
    const unitsInBox = isEven ? Math.round((a.totalQty / boxCount) * 100) / 100 : a.totalQty;

    const landingPrice = master[landingPriceField];
    const taxPct = master.tax;
    const basePrice = landingPrice / (1 + taxPct / 100);
    const taxAmt = landingPrice - basePrice;

    const rowTotalInclusive = landingPrice * a.totalQty;     // shown in "Total Amt INR" column, matches spec
    const rowBaseTotal      = basePrice * a.totalQty;        // contributes to Gross Total
    const rowTaxTotal       = taxAmt * a.totalQty;           // contributes to IGST

    grossTotal += rowBaseTotal;
    igstTotal  += rowTaxTotal;
    finalTotal += rowTotalInclusive;
    totalBoxesSum += boxCount;
    totalUnitsSum += a.totalQty;

    return {
      sku: a.sku,
      // Live UPC on file in SKU_MASTER for this platform right now —
      // not the value that was on the box item back when the shipment
      // was first entered, which is what a.upc holds and which only
      // ever gets stale over time as SKU_MASTER changes. Falls back to
      // that snapshotted value only if SKU_MASTER genuinely has no UPC
      // for this SKU/platform at all.
      upc: (upcField && master[upcField]) ? master[upcField] : a.upc,
      // Field kept named "blinkitItemId" regardless of platform — it's
      // purely an internal data-carrier key consumed by
      // buildRoInvoiceTallyExcel_ client-side, never shown as a label,
      // so there's no need for callers to branch on platform to read it.
      blinkitItemId: master[itemIdField],
      description: master.description,
      hsn: master.hsn,
      mrp: master.mrp,
      box: boxCount,
      unitsInBox: unitsInBox,
      totalUnits: a.totalQty,
      gstRatePct: taxPct,
      landingPrice: landingPrice,
      totalAmtInr: Math.round(rowTotalInclusive * 100) / 100
    };
  });

  // Round off: a single adjustment so Gross + IGST + RoundOff == finalTotal exactly
  const grossRounded = Math.round(grossTotal * 100) / 100;
  const igstRounded  = Math.round(igstTotal * 100) / 100;
  const finalRounded = Math.round(finalTotal * 100) / 100;
  const roundOff = Math.round((finalRounded - grossRounded - igstRounded) * 100) / 100;

  // CGST + SGST split, for intra-state (Rajasthan → Rajasthan) shipments —
  // simply half of the same IGST total each, per standard GST rules.
  // sgstRounded absorbs any odd paisa left after rounding cgst down, so
  // cgst + sgst always equals igstRounded exactly (same pattern as
  // roundOff above, which keeps Gross + IGST + RoundOff == finalTotal).
  const cgstRounded = Math.round((igstRounded / 2) * 100) / 100;
  const sgstRounded = Math.round((igstRounded - cgstRounded) * 100) / 100;

  return {
    rows,
    totals: {
      box: totalBoxesSum,
      unitsInBox: "",
      totalUnits: totalUnitsSum,
      grossTotal: grossRounded,
      igst: igstRounded,
      cgst: cgstRounded,
      sgst: sgstRounded,
      roundOff: roundOff,
      total: finalRounded
    },
    totalQuantity: totalUnitsSum,
    itemCount: rows.length
  };
}

/** Regenerates the full PDF data for an RO Invoice that was ALREADY
 *  created earlier — used by the "Download" button on shipments that
 *  already have one, so it never needs to be recreated from scratch.
 *  Re-aggregates the shipment's boxes against CURRENT SKU_MASTER values
 *  (so if HSN/Tax/Landing Price were corrected after the fact, the
 *  re-download reflects the correction) but does NOT re-check
 *  eligibility/uniqueness/unmapped-SKU status, since this invoice
 *  already exists and was already validated once. */
/** Merges the global Seller settings with the Consignee/Billed-To
 *  details of whichever warehouse this shipment's City matches —
 *  Consignee/Billed-To always depend on the destination warehouse, so
 *  they're never a single global value the way Seller details are. */
function buildRoInvoiceSettings_(city) {
  const seller = getRoSettings();
  const warehouse = getWarehouseByName_(city) || {};
  return {
    sellerName: seller.sellerName,
    sellerGst: seller.sellerGst,
    sellerAddress: seller.sellerAddress,
    consigneeName: warehouse.consigneeName || "",
    consigneeGst: warehouse.consigneeGst || "",
    consigneeAddress: warehouse.consigneeAddress || "",
    billedToName: warehouse.billedToName || "",
    billedToAddress: warehouse.billedToAddress || "",
    state: warehouse.state || "",
    // Tally Excel export only — short free-text label for the "Address
    // Type" column, and the warehouse's Pincode (see addBlinkitWarehouse).
    addressType: warehouse.addressType || "",
    pincode: warehouse.pincode || ""
  };
}

/** Decides how GST is presented on the RO Invoice. The seller is based
 *  in Rajasthan, so a shipment to a Rajasthan warehouse is an
 *  intra-state supply → tax splits into CGST + SGST (half each).
 *  Anything else is inter-state → a single IGST line, as before. */
function roTaxTypeForState_(state) {
  return (state || "").toString().trim().toLowerCase() === "rajasthan"
    ? "CGST_SGST"
    : "IGST";
}

function redownloadRoInvoice_impl_(shipmentId) {
  try {
    const existing = getRoInvoiceForShipment(shipmentId);
    if (!existing) return { success: false, message: "No RO Invoice found for this shipment." };

    const shSheet = ensureShipmentsSheet_();
    const shData = shSheet.getDataRange().getValues();
    let shipmentRow = null;
    for (let i = 1; i < shData.length; i++) {
      if (shData[i][SHIP_COLS.ID - 1] === shipmentId) { shipmentRow = shData[i]; break; }
    }
    if (!shipmentRow) return { success: false, message: "Shipment not found." };

    let boxes = [];
    try { boxes = JSON.parse(shipmentRow[SHIP_COLS.BOXES_JSON - 1] || "[]"); } catch (e) { boxes = []; }

    const skuRows = getSkuData();
    const skuByCode = {};
    skuRows.forEach(r => {
      if (r.sku) skuByCode[r.sku.toUpperCase()] = r;
      if (r.amazonSku) skuByCode[r.amazonSku.toUpperCase()] = r;
    });

    const agg = {};
    boxes.forEach(box => {
      (box.items || []).forEach(item => {
        const key = String(item.sku).trim().toUpperCase();
        if (!agg[key]) agg[key] = { sku: item.sku, upc: item.upc, boxNumbers: new Set(), totalQty: 0, perBoxQty: [] };
        agg[key].boxNumbers.add(box.boxNumber);
        agg[key].totalQty += (parseInt(item.qty, 10) || 0);
        agg[key].perBoxQty.push(parseInt(item.qty, 10) || 0);
      });
    });

    const roFields = roFieldsForPlatform_(shipmentRow[SHIP_COLS.PLATFORM - 1]);
    const built = buildRoInvoiceRows_(agg, skuByCode, roFields.itemIdField, roFields.landingPriceField, roFields.upcField);
    const settings = buildRoInvoiceSettings_(shipmentRow[SHIP_COLS.CITY - 1]);

    return {
      success: true,
      invoice: {
        roInvoiceNumber: existing.roInvoiceNumber,
        roNumber: existing.roNumber,
        invoiceDate: existing.invoiceDate,
        deliveryDate: existing.deliveryDate,
        ewayBillNumber: (existing.ewayBillNumber === undefined || existing.ewayBillNumber === null) ? "" : String(existing.ewayBillNumber),
        deliveryPartner: (existing.deliveryPartner === undefined || existing.deliveryPartner === null) ? "" : String(existing.deliveryPartner),
        totalQuantity: built.totalQuantity,
        itemCount: built.itemCount,
        platform: shipmentRow[SHIP_COLS.PLATFORM - 1],
        city: shipmentRow[SHIP_COLS.CITY - 1],
        poNumber: shipmentRow[SHIP_COLS.PO_NUMBER - 1],
        rows: built.rows,
        totals: built.totals,
        settings: settings,
        taxType: roTaxTypeForState_(settings.state)
      }
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Public wrapper: Apps Script's automatic client-server serialization is
 *  unreliable for complex nested objects like this one (the invoice's
 *  `rows` array in particular has been observed coming back client-side
 *  as a broken Java toString() dump — e.g. "rows=[Ljava.lang.Object;@..."
 *  — instead of real JSON, causing google.script.run's success handler
 *  to receive null even though the server computed everything correctly).
 *  Explicitly JSON.stringify-ing here and JSON.parse-ing on the client
 *  bypasses that broken pathway entirely by sending a single plain string
 *  instead of a nested object graph. */
function redownloadRoInvoice(shipmentId) {
  return JSON.stringify(redownloadRoInvoice_impl_(shipmentId));
}

function createRoInvoice_impl_(params) {
  try {
    const check = checkRoEligibility_(params.shipmentId);
    if (!check.success) return check; // already shaped correctly (incl. unmapped list) for the client
    const { shipmentRow, agg, skuByCode, itemIdField, landingPriceField, upcField } = check;

    // ── Validate required fields (E-way Bill & Delivery Partner are
    //    OPTIONAL — often only known after dispatch, fillable later) ──
    const required = ["roInvoiceNumber", "roNumber", "invoiceDate", "deliveryDate"];
    for (const f of required) {
      if (!params[f] || !String(params[f]).trim()) {
        return { success: false, message: "Missing required field: " + f };
      }
    }

    // ── Validate RO Invoice Number uniqueness, and reserve it, as one
    //    atomic step ──
    // Without a lock, two people creating an RO Invoice with the same
    // (often sequential, manually-typed) number at nearly the same
    // moment could both pass findDuplicateRoInvoiceNumber_'s check
    // before either one's appendRow runs — two shipments would end up
    // sharing one invoice number. Holding the script lock across
    // exactly the check-then-write window (and nothing more — the tax
    // math below doesn't touch this sheet, so it doesn't need the lock)
    // closes that race. A locked-out caller gets a clear, retryable
    // message rather than a raw timeout error.
    const roLock = LockService.getScriptLock();
    try {
      roLock.waitLock(10000);
    } catch (lockErr) {
      return { success: false, message: "Another invoice is being created right now — please try again in a moment." };
    }
    try {
      if (findDuplicateRoInvoiceNumber_(params.roInvoiceNumber, params.shipmentId)) {
        return { success: false, message: "Invoice Number \"" + params.roInvoiceNumber + "\" is already in use. Please use a unique number." };
      }

      // ── Persist the RO Invoice record ──
      const roSheet = ensureRoInvoicesSheet_();
      roSheet.appendRow([
        params.shipmentId, params.roInvoiceNumber, params.roNumber, params.invoiceDate,
        params.deliveryDate, params.ewayBillNumber, params.deliveryPartner,
        params.employee || "", new Date()
      ]);
    } finally {
      roLock.releaseLock();
    }

    // ── Build rows with full tax math ──
    const built = buildRoInvoiceRows_(agg, skuByCode, itemIdField, landingPriceField, upcField);

    // ── Unified invoice number: mirror it onto the shipment so Box
    //    Labels are immediately "completed" with the same number. ──
    updateShipment(params.shipmentId, { invoiceNumber: params.roInvoiceNumber });

    // ── Return everything the client needs to render the PDF ──
    const settings = buildRoInvoiceSettings_(shipmentRow[SHIP_COLS.CITY - 1]);
    return {
      success: true,
      invoice: {
        roInvoiceNumber: params.roInvoiceNumber,
        roNumber: params.roNumber,
        invoiceDate: params.invoiceDate,
        deliveryDate: params.deliveryDate,
        ewayBillNumber: params.ewayBillNumber,
        deliveryPartner: params.deliveryPartner,
        totalQuantity: built.totalQuantity,
        itemCount: built.itemCount,
        platform: shipmentRow[SHIP_COLS.PLATFORM - 1],
        city: shipmentRow[SHIP_COLS.CITY - 1],
        poNumber: shipmentRow[SHIP_COLS.PO_NUMBER - 1],
        rows: built.rows,
        totals: built.totals,
        settings: settings,
        taxType: roTaxTypeForState_(settings.state)
      }
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Public wrapper — see redownloadRoInvoice's wrapper comment above for
 *  why this explicitly JSON.stringify's instead of returning the object
 *  directly. */
function createRoInvoice(params) {
  return JSON.stringify(createRoInvoice_impl_(params));
}

// ════════════════════════════════════════════════════════════════
//  DUMMY ORDER RO INVOICE — Blinkit only. A "Dummy Order" is a PO
//  uploaded purely to get an RO Invoice out of the system (no real
//  fulfillment behind it) — flagged at upload time via the "Dummy
//  Order" checkbox in the Upload PO popup (see uploadBlinkitPo's
//  IS_DUMMY column). A shipment built against a dummy PO is never
//  saved anywhere: submitShipment/syncShipmentInventory_ are never
//  called for it (see submitForm's currentPoIsDummy_ branch in
//  ShipmentManagerIndex.html) — the whole thing lives in the browser
//  tab's memory only, for exactly as long as that tab stays open, and
//  touches Inventory, the Shipments sheet, and the RO_INVOICES sheet
//  nowhere at all. The functions below are the ONLY server-side
//  involvement a dummy shipment ever has: computing an RO Invoice's
//  numbers from boxes handed to it directly (never a stored shipment
//  ID, since none exists), same tax math as a real one, but nothing
//  written down — not even an invoice-number-uniqueness check against
//  real invoices on file, since nothing here is meant to be traceable
//  or reusable afterward.
// ════════════════════════════════════════════════════════════════

/** Same aggregation + unmapped-SKU-mapping check as checkRoEligibility_
 *  above, but operating directly on a raw boxes array instead of
 *  looking up a shipment by ID. Deliberately NOT shared with
 *  checkRoEligibility_ itself (a little duplication here is a much
 *  smaller risk than the real RO Invoice flow ever being affected by a
 *  change made for the dummy path). */
function checkDummyRoEligibility_(boxes, platform) {
  platform = (platform || 'blinkit').toString().trim().toLowerCase();
  if (platform !== 'blinkit') return { success:false, message:"Dummy Order RO Invoice is only available for Blinkit." };
  if (!boxes || !boxes.length) return { success:false, message:"No boxes to invoice." };

  const roFields = roFieldsForPlatform_(platform);
  const skuRows = getSkuData();
  const skuByCode = {};
  skuRows.forEach(r => {
    if (r.sku) skuByCode[r.sku.toUpperCase()] = r;
    if (r.amazonSku) skuByCode[r.amazonSku.toUpperCase()] = r;
  });

  const agg = {};
  boxes.forEach(box => {
    (box.items || []).forEach(item => {
      const key = String(item.sku).trim().toUpperCase();
      if (!agg[key]) agg[key] = { sku: item.sku, upc: item.upc, boxNumbers: new Set(), totalQty: 0, perBoxQty: [] };
      agg[key].boxNumbers.add(box.boxNumber);
      agg[key].totalQty += (parseInt(item.qty, 10) || 0);
      agg[key].perBoxQty.push(parseInt(item.qty, 10) || 0);
    });
  });

  const unmapped = [];
  Object.values(agg).forEach(a => {
    const master = skuByCode[String(a.sku).trim().toUpperCase()];
    if (!master || !master[roFields.itemIdField] || !master.mrp || !master.hsn || !master.tax || !master[roFields.landingPriceField]) {
      unmapped.push(a.sku);
    }
  });
  if (unmapped.length) {
    return { success:false, unmapped:true, unmappedSkus:unmapped,
      message: "The following SKU(s) are not fully mapped for RO Invoice (Item ID / MRP / HSN / Tax / Landing Price): " + unmapped.join(", ") };
  }

  return { success:true, agg, skuByCode, itemIdField: roFields.itemIdField, landingPriceField: roFields.landingPriceField, upcField: roFields.upcField };
}

/** Lightweight pre-check for the Dummy Order RO Invoice form — mirrors
 *  getRoEligibility() but takes the boxes straight from the client's
 *  in-memory dummy shipment instead of looking one up by ID. */
function getDummyRoEligibility(boxes, platform) {
  const result = checkDummyRoEligibility_(boxes, platform);
  if (!result.success) return result;
  return { success:true };
}

/** Dummy-Order counterpart to createRoInvoice_impl_ above — computes and
 *  returns the exact same `invoice` shape (so the client's existing PDF
 *  renderer, buildRoInvoiceHtml_, works completely unchanged) but
 *  deliberately skips everything that writes anywhere: no RO_INVOICES
 *  row, no invoice-number lock/uniqueness check, no updateShipment call
 *  (there's no saved shipment to update). Nothing here touches
 *  Inventory, the Shipments sheet, or the RO_INVOICES sheet. */
function createDummyRoInvoice_impl_(params) {
  try {
    const platform = (params.platform || 'blinkit').toString().trim().toLowerCase();
    const check = checkDummyRoEligibility_(params.boxes, platform);
    if (!check.success) return check;
    const { agg, skuByCode, itemIdField, landingPriceField, upcField } = check;

    const required = ["roInvoiceNumber", "roNumber", "invoiceDate", "deliveryDate"];
    for (const f of required) {
      if (!params[f] || !String(params[f]).trim()) {
        return { success: false, message: "Missing required field: " + f };
      }
    }

    const built = buildRoInvoiceRows_(agg, skuByCode, itemIdField, landingPriceField, upcField);
    const settings = buildRoInvoiceSettings_(params.city);
    return {
      success: true,
      invoice: {
        roInvoiceNumber: params.roInvoiceNumber,
        roNumber: params.roNumber,
        invoiceDate: params.invoiceDate,
        deliveryDate: params.deliveryDate,
        ewayBillNumber: params.ewayBillNumber,
        deliveryPartner: params.deliveryPartner,
        totalQuantity: built.totalQuantity,
        itemCount: built.itemCount,
        platform: platform,
        city: params.city,
        poNumber: params.poNumber,
        rows: built.rows,
        totals: built.totals,
        settings: settings,
        taxType: roTaxTypeForState_(settings.state),
        isDummy: true
      }
    };
  } catch (err) { return { success: false, message: err.message }; }
}

/** Public wrapper — JSON.stringify'd for the same reason as
 *  createRoInvoice's wrapper (see redownloadRoInvoice's comment). */
function createDummyRoInvoice(params) {
  return JSON.stringify(createDummyRoInvoice_impl_(params));
}

/** Voids the PO a Dummy Order shipment was built against, called when
 *  that shipment is deleted (see deleteShipment's dummy branch in
 *  ShipmentManagerIndex.html — dummy shipments are never saved, so
 *  they never go through deleteShipmentRecord, which is what does this
 *  for a real shipment). Reuses the exact same fullyCancelPo_ a real
 *  delete uses, so a used-and-discarded dummy PO drops out of the PO
 *  dropdown the same way — otherwise nothing ever would, since dummy
 *  shipments never touch SHIPPED_QTY. Only ever cancels a PO actually
 *  flagged IS_DUMMY, as a guard against this path voiding a real one. */
function cancelDummyPo(platform, poNumber) {
  try {
    platform = (platform || 'blinkit').toString().trim().toLowerCase();
    if (platform !== 'blinkit') return { success: false, message: "Dummy Order is only available for Blinkit." };
    poNumber = (poNumber || '').toString().trim();
    if (!poNumber) return { success: false, message: "No PO Number given." };
    const sheet = ensurePoSheet_(platform);
    const data = sheet.getDataRange().getValues();
    const isDummyPo = data.slice(1).some(r =>
      (r[PO_COLS.PO_NUMBER - 1] || "").toString().trim() === poNumber &&
      (r[PO_COLS.IS_DUMMY - 1] === true || r[PO_COLS.IS_DUMMY - 1] === "TRUE")
    );
    if (!isDummyPo) return { success: false, message: "PO " + poNumber + " is not a Dummy Order — refusing to cancel it." };
    fullyCancelPo_(platform, poNumber);
    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
}

/** Lightweight fetch of just the E-way Bill Number and Delivery
 *  Partner for an already-created RO Invoice — used to pre-fill the
 *  "Edit E-way Bill / Delivery Partner" modal from the shipments list,
 *  without re-running the full aggregation/tax math that
 *  redownloadRoInvoice() does. */
function getRoInvoiceDetails_impl_(shipmentId) {
  try {
    const existing = getRoInvoiceForShipment(shipmentId);
    if (!existing) return { success: false, message: "No RO Invoice found for this shipment." };
    return {
      success: true,
      roInvoiceNumber: existing.roInvoiceNumber,
      roNumber: existing.roNumber,
      // Explicitly stringified — a raw Date object returned to the client
      // has been part of what triggers Apps Script's broken serialization
      // (see the wrapper comment on redownloadRoInvoice for the full story).
      invoiceDate: existing.invoiceDate instanceof Date ? toDateString_(existing.invoiceDate) : (existing.invoiceDate || ""),
      deliveryDate: existing.deliveryDate instanceof Date ? toDateString_(existing.deliveryDate) : (existing.deliveryDate || ""),
      // Always a string — Sheets stores a purely-numeric E-way Bill
      // Number cell as a number type, and the client calls .replace()
      // on this value assuming it's text.
      ewayBillNumber: (existing.ewayBillNumber === undefined || existing.ewayBillNumber === null) ? "" : String(existing.ewayBillNumber),
      deliveryPartner: (existing.deliveryPartner === undefined || existing.deliveryPartner === null) ? "" : String(existing.deliveryPartner)
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Public wrapper — see redownloadRoInvoice's wrapper comment for why
 *  this explicitly JSON.stringify's instead of returning the object
 *  directly (Apps Script's automatic serialization has been observed
 *  silently corrupting moderately complex return values into garbage,
 *  which the client then receives as a bare null). */
function getRoInvoiceDetails(shipmentId) {
  return JSON.stringify(getRoInvoiceDetails_impl_(shipmentId));
}

/** Updates the E-way Bill Number and/or Delivery Partner on an
 *  already-created RO Invoice. These two fields are often only known
 *  for certain after dispatch — well after the invoice itself was
 *  generated — so employees need to be able to correct them later from
 *  the shipments list, without touching invoice numbering, dates, or
 *  any of the tax-calculated line items. */
function updateRoInvoiceDetails(shipmentId, ewayBillNumber, deliveryPartner) {
  try {
    ewayBillNumber = (ewayBillNumber || "").toString().trim();
    deliveryPartner = (deliveryPartner || "").toString().trim();
    // Both are optional — blanks are allowed (fields are typically
    // filled in only after dispatch, and may legitimately be cleared).

    const sheet = ensureRoInvoicesSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, message: "No RO Invoice found for this shipment." };

    const ids = sheet.getRange(2, RO_COLS.SHIPMENT_ID, lastRow - 1, 1).getValues();
    let rowIndex = -1;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i][0] === shipmentId) { rowIndex = i + 2; break; }
    }
    if (rowIndex === -1) return { success: false, message: "No RO Invoice found for this shipment." };

    sheet.getRange(rowIndex, RO_COLS.EWAY_BILL_NUMBER).setValue(ewayBillNumber);
    sheet.getRange(rowIndex, RO_COLS.DELIVERY_PARTNER).setValue(deliveryPartner);

    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Edit an existing RO Invoice: re-aggregates the shipment's CURRENT
 *  box details (so any changes since creation are picked up), lets the
 *  invoice number / dates / E-way / Delivery Partner be changed, then
 *  UPDATES the existing RO_INVOICES row in place (rather than creating
 *  a second one) and mirrors the number onto the shipment. Returns the
 *  same invoice object as createRoInvoice so the client can regenerate
 *  the PDF. */
function updateRoInvoice_impl_(params) {
  try {
    const check = checkRoEligibility_(params.shipmentId, { allowExisting: true });
    if (!check.success) return check; // includes unmapped-SKU shape for the client
    const { shipmentRow, agg, skuByCode, itemIdField, landingPriceField, upcField } = check;

    const required = ["roInvoiceNumber", "roNumber", "invoiceDate", "deliveryDate"];
    for (const f of required) {
      if (!params[f] || !String(params[f]).trim()) {
        return { success: false, message: "Missing required field: " + f };
      }
    }

    // Locate this shipment's existing RO row.
    const roSheet = ensureRoInvoicesSheet_();
    const lastRow = roSheet.getLastRow();
    let rowIndex = -1;
    if (lastRow >= 2) {
      const ids = roSheet.getRange(2, RO_COLS.SHIPMENT_ID, lastRow - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (ids[i][0] === params.shipmentId) { rowIndex = i + 2; break; }
      }
    }
    if (rowIndex === -1) return { success: false, message: "No RO Invoice found to edit for this shipment." };

    // Unique invoice number, excluding this shipment's own rows — and
    // the void-old-number + actual writes below, all as one atomic
    // step under the script lock, same reasoning as createRoInvoice_impl_.
    const roLock = LockService.getScriptLock();
    try {
      roLock.waitLock(10000);
    } catch (lockErr) {
      return { success: false, message: "Another invoice is being created or edited right now — please try again in a moment." };
    }
    try {
      if (findDuplicateRoInvoiceNumber_(params.roInvoiceNumber, params.shipmentId)) {
        return { success: false, message: "Invoice Number \"" + params.roInvoiceNumber + "\" is already in use. Please use a unique number." };
      }

      // The number is about to be overwritten below — permanently void the
      // OLD one first if it's actually changing, so it can never be reused
      // on any other shipment (or accidentally reapplied to this one).
      const oldInvoiceNumber = (roSheet.getRange(rowIndex, RO_COLS.RO_INVOICE_NUMBER).getValue() || "").toString().trim();
      if (oldInvoiceNumber && oldInvoiceNumber.toLowerCase() !== String(params.roInvoiceNumber).trim().toLowerCase()) {
        recordCancelledInvoiceNumber_(oldInvoiceNumber, params.shipmentId, "RO_INVOICE_EDITED", params.employee);
      }

      // Update the existing RO row in place (keep CREATED_BY / CREATED_TS).
      roSheet.getRange(rowIndex, RO_COLS.RO_INVOICE_NUMBER).setValue(params.roInvoiceNumber);
      roSheet.getRange(rowIndex, RO_COLS.RO_NUMBER).setValue(params.roNumber);
      roSheet.getRange(rowIndex, RO_COLS.INVOICE_DATE).setValue(params.invoiceDate);
      roSheet.getRange(rowIndex, RO_COLS.DELIVERY_DATE).setValue(params.deliveryDate);
      roSheet.getRange(rowIndex, RO_COLS.EWAY_BILL_NUMBER).setValue(params.ewayBillNumber || "");
      roSheet.getRange(rowIndex, RO_COLS.DELIVERY_PARTNER).setValue(params.deliveryPartner || "");
    } finally {
      roLock.releaseLock();
    }

    // Re-aggregate current boxes → fresh line items / totals (read-only —
    // doesn't need the lock).
    const built = buildRoInvoiceRows_(agg, skuByCode, itemIdField, landingPriceField, upcField);

    // Keep the unified number in sync on the shipment too.
    updateShipment(params.shipmentId, { invoiceNumber: params.roInvoiceNumber });

    const settings = buildRoInvoiceSettings_(shipmentRow[SHIP_COLS.CITY - 1]);
    return {
      success: true,
      invoice: {
        roInvoiceNumber: params.roInvoiceNumber,
        roNumber: params.roNumber,
        invoiceDate: params.invoiceDate,
        deliveryDate: params.deliveryDate,
        ewayBillNumber: params.ewayBillNumber || "",
        deliveryPartner: params.deliveryPartner || "",
        totalQuantity: built.totalQuantity,
        itemCount: built.itemCount,
        platform: shipmentRow[SHIP_COLS.PLATFORM - 1],
        city: shipmentRow[SHIP_COLS.CITY - 1],
        poNumber: shipmentRow[SHIP_COLS.PO_NUMBER - 1],
        rows: built.rows,
        totals: built.totals,
        settings: settings,
        taxType: roTaxTypeForState_(settings.state)
      }
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Public wrapper — see redownloadRoInvoice's wrapper comment above for
 *  why this explicitly JSON.stringify's instead of returning the object
 *  directly. */
function updateRoInvoice(params) {
  return JSON.stringify(updateRoInvoice_impl_(params));
}

/** Internal: does an RO row already exist for this shipment? Returns the
 *  1-based sheet row index, or -1. */
function findRoRowIndex_(shipmentId) {
  const roSheet = ensureRoInvoicesSheet_();
  const lastRow = roSheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = roSheet.getRange(2, RO_COLS.SHIPMENT_ID, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === shipmentId) return i + 2;
  }
  return -1;
}

/** Internal: auto-create an RO Invoice record for a Blinkit or Zepto
 *  shipment using the given invoice number and sensible defaults (today's dates, blank
 *  E-way/Delivery Partner — both optional). Silently no-ops (with a
 *  reason) if the shipment isn't eligible (e.g. unmapped SKUs) so the
 *  calling flow — setting the invoice number — still succeeds. */
function autoCreateRoInvoice_(shipmentId, invoiceNumber, employee) {
  const check = checkRoEligibility_(shipmentId);
  if (!check.success) {
    return { created: false, reason: check.unmapped ? "unmapped SKUs" : (check.message || "not eligible") };
  }
  const { shipmentRow } = check;
  const today = toDateString_(new Date());
  const roSheet = ensureRoInvoicesSheet_();
  roSheet.appendRow([
    shipmentId, invoiceNumber, shipmentRow[SHIP_COLS.PO_NUMBER - 1], today,
    today, "", "", employee || "", new Date()
  ]);
  return { created: true };
}

/** Public: set the unified invoice number on a shipment and propagate
 *  it. Called by the Box Labels invoice modal. For Blinkit shipments it
 *  ALSO completes the RO Invoice step automatically — updating the
 *  existing RO row's number, or auto-creating one if none exists yet.
 *  Returns hasRoInvoice + an optional warning if RO couldn't be
 *  auto-created (the invoice number is still saved either way). */
function setInvoiceNumberAndSyncRo(shipmentId, invoiceNumber, platform, employee) {
  try {
    invoiceNumber = (invoiceNumber || "").toString().trim();
    if (!invoiceNumber) return { success: false, message: "Invoice Number is required." };

    // Enforce global uniqueness of the unified number (excluding self).
    if (findDuplicateRoInvoiceNumber_(invoiceNumber, shipmentId)) {
      return { success: false, message: "Invoice Number \"" + invoiceNumber + "\" is already in use. Please use a unique number." };
    }

    const setRes = updateShipment(shipmentId, { invoiceNumber: invoiceNumber });
    if (!setRes.success) return setRes;

    const result = { success: true, hasRoInvoice: false, roCreated: false, warning: "" };
    // Keep the RO Invoice record's number in step with whatever real
    // invoice number the person just entered, for ANY PO-driven
    // platform (Blinkit/Zepto/Swiggy) — not just Blinkit. Zepto/Swiggy
    // shipments get their RO row auto-created at submit time with a
    // placeholder number (ZI-<PO>/SW-<PO> — see autoCreateRoInvoice_'s
    // call sites in saveShipment), purely so a Tally Excel export has
    // something to read before a real invoice number ever exists. If
    // that placeholder is never synced to the REAL number once one is
    // entered here, Tally Excel keeps showing the placeholder as the
    // Voucher Number forever — wrong, and inconsistent with Blinkit,
    // where this sync already worked correctly.
    if (poPlatformConfig_((platform || "").toString().trim().toLowerCase())) {
      const roRow = findRoRowIndex_(shipmentId);
      if (roRow !== -1) {
        ensureRoInvoicesSheet_().getRange(roRow, RO_COLS.RO_INVOICE_NUMBER).setValue(invoiceNumber);
        result.hasRoInvoice = true;
      } else {
        const ac = autoCreateRoInvoice_(shipmentId, invoiceNumber, employee);
        if (ac.created) { result.hasRoInvoice = true; result.roCreated = true; }
        else { result.warning = "Invoice Number saved, but the RO Invoice could not be auto-created (" + ac.reason + ")."; }
      }
    }
    return result;
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Public: keep the RO Invoice's number in step with the shipment's
 *  invoice number after an Edit Shipment save. Same behaviour as the
 *  Box Labels sync (update existing RO, or auto-create), but tolerant
 *  of a blank number (nothing to sync). Applies to any PO-driven
 *  platform (Blinkit/Zepto/Swiggy) — see setInvoiceNumberAndSyncRo's
 *  comment for why this can't be Blinkit-only. */
function syncRoInvoiceNumber(shipmentId, invoiceNumber, platform, employee) {
  try {
    invoiceNumber = (invoiceNumber || "").toString().trim();
    const result = { success: true, hasRoInvoice: false, roCreated: false, warning: "" };
    if (!invoiceNumber) return result;
    if (!poPlatformConfig_((platform || "").toString().trim().toLowerCase())) return result;

    const roRow = findRoRowIndex_(shipmentId);
    if (roRow !== -1) {
      ensureRoInvoicesSheet_().getRange(roRow, RO_COLS.RO_INVOICE_NUMBER).setValue(invoiceNumber);
      result.hasRoInvoice = true;
    } else {
      const ac = autoCreateRoInvoice_(shipmentId, invoiceNumber, employee);
      if (ac.created) { result.hasRoInvoice = true; result.roCreated = true; }
      else { result.warning = "RO Invoice could not be auto-created (" + ac.reason + ")."; }
    }
    return result;
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Checks the PO Number and/or Invoice Number against every non-deleted
 *  shipment (excluding excludeId, e.g. the shipment currently being
 *  edited, so saving a shipment unchanged doesn't flag itself).
 *  Returns { poDuplicate: bool, invoiceDuplicate: bool } so the caller
 *  can build a precise error message. Comparison is case-insensitive
 *  and trims whitespace; blank values are never treated as duplicates
 *  (an empty invoice number is normal before the Box Labels step). */
function findDuplicateShipmentField_(poNumber, invoiceNumber, excludeId) {
  const sheet = ensureShipmentsSheet_();
  const lastRow = sheet.getLastRow();
  const result = { poDuplicate: false, invoiceDuplicate: false };

  const poTrim  = (poNumber || "").toString().trim().toLowerCase();
  const invTrim = (invoiceNumber || "").toString().trim().toLowerCase();
  if (!poTrim && !invTrim) return result;

  if (invTrim && isInvoiceNumberCancelled_(invoiceNumber)) result.invoiceDuplicate = true;
  if (lastRow < 2) return result;

  const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues(); // through DELETED col
  for (const row of data) {
    if (excludeId && row[SHIP_COLS.ID - 1] === excludeId) continue;
    const deleted = row[SHIP_COLS.DELETED - 1];
    if (deleted === true || deleted === "TRUE") continue;

    if (poTrim) {
      const rowPo = (row[SHIP_COLS.PO_NUMBER - 1] || "").toString().trim().toLowerCase();
      if (rowPo && rowPo === poTrim) result.poDuplicate = true;
    }
    if (invTrim) {
      const rowInv = (row[SHIP_COLS.INVOICE_NUMBER - 1] || "").toString().trim().toLowerCase();
      if (rowInv && rowInv === invTrim) result.invoiceDuplicate = true;
    }
  }
  return result;
}

// Save a brand-new shipment record. Returns the generated id.
function saveShipment(payload) {
  /*
  payload = {
    employee, role, platform, poNumber, invoiceNumber, date, city,
    boxes: [{ boxNumber, items: [{ sku, upc, qty, weightPerUnit }] }]
  }
  */
  try {
    const sheet = ensureShipmentsSheet_();
    const id = "S" + Date.now() + Math.floor(Math.random() * 1000);
    const ts = new Date();
    sheet.appendRow([
      id, ts, payload.employee, payload.role || "employee", payload.platform,
      payload.poNumber, payload.invoiceNumber || "", payload.date, payload.city,
      JSON.stringify(payload.boxes || []), false, ""
    ]);
    return { success: true, id, ts: ts.toISOString() };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Fetch all non-deleted shipments, optionally filtered to a single date
// (YYYY-MM-DD) or, when dateFilterEnd is also given, an inclusive date
// RANGE [dateFilter, dateFilterEnd] (e.g. the Dashboard's "Last 7 Days"
// widgets link through to Shipments with both bounds set). Visible to
// every logged-in employee (not restricted by who created it).
function getShipments(dateFilter, dateFilterEnd) {
  try {
    const sheet = ensureShipmentsSheet_();
    const data = sheet.getDataRange().getValues();
    const rows = data.slice(1);

    // PERFORMANCE: read RO_INVOICES ONCE into a Set of shipment IDs that
    // already have one, instead of checking each shipment individually
    // (which would mean re-reading the whole RO_INVOICES sheet once per
    // shipment — an ever-growing sheet, exactly the kind of repeated
    // full-sheet-scan pattern this project has deliberately avoided
    // elsewhere).
    const roSheet = ensureRoInvoicesSheet_();
    const roLastRow = roSheet.getLastRow();
    const roShipmentIds = new Set();
    if (roLastRow >= 2) {
      roSheet.getRange(2, RO_COLS.SHIPMENT_ID, roLastRow - 1, 1).getValues()
        .forEach(r => { if (r[0]) roShipmentIds.add(r[0]); });
    }

    const result = [];
    for (const r of rows) {
      const deleted = r[SHIP_COLS.DELETED - 1];
      if (deleted === true || deleted === "TRUE") continue;
      const rowDate = formatDateForCompare_(r[SHIP_COLS.DATE - 1]);
      if (dateFilterEnd) {
        // Range mode — string comparison works since formatDateForCompare_
        // always returns YYYY-MM-DD, which sorts chronologically as text.
        if (dateFilter && rowDate < dateFilter) continue;
        if (rowDate > dateFilterEnd) continue;
      } else if (dateFilter && rowDate !== dateFilter) continue;
      let boxes = [];
      try { boxes = JSON.parse(r[SHIP_COLS.BOXES_JSON - 1] || "[]"); } catch (e) { boxes = []; }
      result.push({
        id:             r[SHIP_COLS.ID - 1],
        ts:             r[SHIP_COLS.TIMESTAMP - 1] instanceof Date ? r[SHIP_COLS.TIMESTAMP - 1].toISOString() : r[SHIP_COLS.TIMESTAMP - 1],
        employee:       r[SHIP_COLS.EMPLOYEE - 1],
        platform:       r[SHIP_COLS.PLATFORM - 1],
        poNumber:       r[SHIP_COLS.PO_NUMBER - 1],
        invoiceNumber:  r[SHIP_COLS.INVOICE_NUMBER - 1] || "",
        date:           rowDate,
        city:           r[SHIP_COLS.CITY - 1],
        boxes:          boxes,
        hasRoInvoice:   roShipmentIds.has(r[SHIP_COLS.ID - 1]),
        adjustments:    parseShipmentAdjustments_(r[SHIP_COLS.ADJUSTMENTS_JSON - 1])
      });
    }
    // newest first
    result.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    return result;
  } catch (err) {
    return [];
  }
}

function formatDateForCompare_(val) {
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = ("0" + (val.getMonth() + 1)).slice(-2);
    const d = ("0" + val.getDate()).slice(-2);
    return y + "-" + m + "-" + d;
  }
  return (val || "").toString().trim();
}

/** Powers the Dashboard tab. Single pass over the SHIPMENTS sheet:
 *   - yesterdayCount / todayCount: shipment counts for those exact dates
 *   - topSkus / topWarehouses: top 5 by total quantity shipped, and
 *   - platformTotals: every platform's total quantity shipped,
 *     all three over a rolling 7-day window (today + the 6 days before it).
 *  Quantity = sum of item.qty across every box on a shipment. Warehouse
 *  name is the shipment's CITY field (for Blinkit shipments this IS the
 *  warehouse name — see the "+ Add New Warehouse" flow). */
function getDashboardStats() {
  try {
    const sheet = ensureShipmentsSheet_();
    const data = sheet.getDataRange().getValues();
    const rows = data.slice(1);

    const today = new Date();
    const todayStr = formatDateForCompare_(today);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDateForCompare_(yesterday);
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6); // rolling 7-day window incl. today
    const weekStartStr = formatDateForCompare_(weekStart);

    // Ordered day-strings for the rolling window, oldest first — doubles
    // as both the line charts' x-axis labels and the lookup keys into
    // the per-day accumulators below.
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      days.push(formatDateForCompare_(d));
    }

    let yesterdayCount = 0, todayCount = 0, last7DaysCount = 0;
    const skuQty = {}, whQty = {}, platQty = {};
    const skuByDay = {}, whByDay = {}; // day -> key -> qty, for the two line charts

    rows.forEach(r => {
      const deleted = r[SHIP_COLS.DELETED - 1];
      if (deleted === true || deleted === "TRUE") return;
      const rowDate = formatDateForCompare_(r[SHIP_COLS.DATE - 1]);
      if (rowDate === yesterdayStr) yesterdayCount++;
      if (rowDate === todayStr) todayCount++;
      if (rowDate < weekStartStr || rowDate > todayStr) return; // outside 7-day window
      last7DaysCount++;

      let boxes = [];
      try { boxes = JSON.parse(r[SHIP_COLS.BOXES_JSON - 1] || "[]"); } catch (e) { boxes = []; }
      const platform = (r[SHIP_COLS.PLATFORM - 1] || "").toString().trim();
      const city = (r[SHIP_COLS.CITY - 1] || "").toString().trim();
      let shipmentQty = 0;
      boxes.forEach(box => {
        (box.items || []).forEach(item => {
          const qty = parseInt(item.qty, 10) || 0;
          shipmentQty += qty;
          if (item.sku) {
            const skuKey = item.sku.toString().trim();
            skuQty[skuKey] = (skuQty[skuKey] || 0) + qty;
            if (!skuByDay[rowDate]) skuByDay[rowDate] = {};
            skuByDay[rowDate][skuKey] = (skuByDay[rowDate][skuKey] || 0) + qty;
          }
        });
      });
      if (city) {
        whQty[city] = (whQty[city] || 0) + shipmentQty;
        if (!whByDay[rowDate]) whByDay[rowDate] = {};
        whByDay[rowDate][city] = (whByDay[rowDate][city] || 0) + shipmentQty;
      }
      if (platform) platQty[platform] = (platQty[platform] || 0) + shipmentQty;
    });

    const topN = (map, n) => Object.keys(map)
      .map(k => ({ key: k, qty: map[k] }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, n);

    const topSkus = topN(skuQty, 5);
    const topWarehouses = topN(whQty, 5);

    // Day-by-day series for ONLY the top 5 keys (by 7-day total) — a
    // 7-point line per key, 0-filled for any day it didn't ship at all,
    // so both charts get equal-length arrays lined up against `days`.
    const buildChartSeries_ = (topList, byDay) => ({
      days: days,
      series: topList.map(t => ({
        name: t.key,
        data: days.map(d => (byDay[d] && byDay[d][t.key]) || 0)
      }))
    });

    return {
      yesterdayCount,
      yesterdayDate: yesterdayStr,
      todayCount,
      todayDate: todayStr,
      last7DaysCount,
      weekStartDate: weekStartStr,
      weekEndDate: todayStr,
      topSkus: topSkus.map(x => ({ sku: x.key, qty: x.qty })),
      topWarehouses: topWarehouses.map(x => ({ name: x.key, qty: x.qty })),
      topSkusChart: buildChartSeries_(topSkus, skuByDay),
      topWarehousesChart: buildChartSeries_(topWarehouses, whByDay),
      platformTotals: Object.keys(platQty)
        .map(k => ({ platform: k, qty: platQty[k] }))
        .sort((a, b) => b.qty - a.qty)
    };
  } catch (err) {
    return {
      yesterdayCount: 0, yesterdayDate: "", todayCount: 0, todayDate: "", last7DaysCount: 0,
      weekStartDate: "", weekEndDate: "",
      topSkus: [], topWarehouses: [],
      topSkusChart: { days: [], series: [] }, topWarehousesChart: { days: [], series: [] },
      platformTotals: [], error: err.message
    };
  }
}

function updateShipment(id, updates) {
  try {
    const sheet = ensureShipmentsSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][SHIP_COLS.ID - 1] === id) {
        const row = i + 1;

        // Validate uniqueness BEFORE writing anything. Only check fields
        // that are actually being changed in this call — e.g. a qty-only
        // edit or setShipmentInvoiceNumber() shouldn't re-validate a PO
        // number that isn't part of this update.
        const checkPo  = updates.poNumber      !== undefined ? updates.poNumber      : null;
        const checkInv = updates.invoiceNumber !== undefined ? updates.invoiceNumber : null;
        if (checkPo || checkInv) {
          const dupCheck = findDuplicateShipmentField_(checkPo, checkInv, id);
          if (checkPo && dupCheck.poDuplicate) {
            return { success: false, message: "PO Number \"" + checkPo + "\" is already used by another shipment. Please use a unique PO Number." };
          }
          if (checkInv && dupCheck.invoiceDuplicate) {
            return { success: false, message: "Invoice Number \"" + checkInv + "\" is already used by another shipment. Please use a unique Invoice Number." };
          }
        }

        // If the invoice number is actually changing, permanently void
        // the old one first — this is the only invoice-number edit path
        // NOT already covered by updateRoInvoice_impl_ (the plain Edit
        // Shipment screen changes it directly, without going through
        // Edit RO), so it needs the same protection here.
        if (updates.invoiceNumber !== undefined) {
          const oldInv = (data[i][SHIP_COLS.INVOICE_NUMBER - 1] || "").toString().trim();
          if (oldInv && oldInv.toLowerCase() !== String(updates.invoiceNumber).trim().toLowerCase()) {
            recordCancelledInvoiceNumber_(oldInv, id, "SHIPMENT_EDITED", updates.changedBy);
          }
        }

        // PO-driven-platform sync (Blinkit, Zepto) — BEFORE writing
        // anything, so an edit that would push a PO over its remaining
        // balance is rejected outright. Handles all four cases: staying
        // on the same PO (simple delta), moving to a different PO, moving
        // off a PO-driven platform entirely (reverse the old PO's
        // deduction), or moving onto one from another platform (apply
        // fresh against the new PO).
        const oldPlatform = (data[i][SHIP_COLS.PLATFORM - 1] || "").toString().trim();
        const oldPoNumber = (data[i][SHIP_COLS.PO_NUMBER - 1] || "").toString().trim();
        let oldBoxesForPo = [];
        try { oldBoxesForPo = JSON.parse(data[i][SHIP_COLS.BOXES_JSON - 1] || "[]"); } catch (e) { oldBoxesForPo = []; }
        const newPlatform = updates.platform !== undefined ? updates.platform : oldPlatform;
        const newPoNumber = updates.poNumber !== undefined ? updates.poNumber : oldPoNumber;
        const newBoxesForPo = updates.boxes !== undefined ? updates.boxes : oldBoxesForPo;
        const oldPlatformLower = oldPlatform.toLowerCase();
        const newPlatformLower = (newPlatform || "").toString().trim().toLowerCase();
        const oldIsPoDriven = !!poPlatformConfig_(oldPlatformLower) && !!oldPoNumber;
        const newIsPoDriven = !!poPlatformConfig_(newPlatformLower) && !!newPoNumber;
        const boxesActuallyChanged = updates.boxes !== undefined || updates.platform !== undefined || updates.poNumber !== undefined;
        if (boxesActuallyChanged) {
          if (oldIsPoDriven && newIsPoDriven && oldPlatformLower === newPlatformLower && oldPoNumber === newPoNumber) {
            // Same platform, same PO — a single delta update covers it.
            const poUpdate = validateAndUpdatePoShipped_(newPlatformLower, newPoNumber, newBoxesForPo, oldBoxesForPo, true);
            if (!poUpdate.success) return { success: false, message: poUpdate.errors.join(" ") };
          } else {
            // PO number and/or platform changed — reverse the old PO's
            // deduction first (frees up that capacity), then apply fresh
            // against the new PO if it's still/now PO-driven. Validated
            // separately since they're two independent PO records.
            if (oldIsPoDriven) validateAndUpdatePoShipped_(oldPlatformLower, oldPoNumber, [], oldBoxesForPo, true);
            if (newIsPoDriven) {
              const poUpdate = validateAndUpdatePoShipped_(newPlatformLower, newPoNumber, newBoxesForPo, [], true);
              if (!poUpdate.success) return { success: false, message: poUpdate.errors.join(" ") };
            }
          }
        }

        if (updates.platform      !== undefined) sheet.getRange(row, SHIP_COLS.PLATFORM).setValue(updates.platform);
        if (updates.poNumber      !== undefined) sheet.getRange(row, SHIP_COLS.PO_NUMBER).setValue(updates.poNumber);
        if (updates.invoiceNumber !== undefined) sheet.getRange(row, SHIP_COLS.INVOICE_NUMBER).setValue(updates.invoiceNumber);
        if (updates.date          !== undefined) sheet.getRange(row, SHIP_COLS.DATE).setValue(updates.date);
        if (updates.city          !== undefined) sheet.getRange(row, SHIP_COLS.CITY).setValue(updates.city);
        if (updates.boxes         !== undefined) sheet.getRange(row, SHIP_COLS.BOXES_JSON).setValue(JSON.stringify(updates.boxes));
        sheet.getRange(row, SHIP_COLS.EDITED_TS).setValue(new Date());

        // Re-sync Inventory whenever anything that affects the deduction
        // OR the cell-note comment changes — box contents, date, platform,
        // city, or PO number. setShipmentInvoiceNumber() calls this with
        // none of these set, so it correctly skips a sync.
        let inventoryWarning = "";
        const touchesInventory = updates.boxes !== undefined || updates.date !== undefined ||
          updates.platform !== undefined || updates.city !== undefined || updates.poNumber !== undefined;
        if (touchesInventory) {
          const finalDate     = updates.date     !== undefined ? updates.date     : data[i][SHIP_COLS.DATE - 1];
          const finalBoxes    = updates.boxes    !== undefined ? updates.boxes    : JSON.parse(data[i][SHIP_COLS.BOXES_JSON - 1] || "[]");
          const finalPlatform = updates.platform !== undefined ? updates.platform : data[i][SHIP_COLS.PLATFORM - 1];
          const finalCity     = updates.city     !== undefined ? updates.city     : data[i][SHIP_COLS.CITY - 1];
          const finalPo       = updates.poNumber !== undefined ? updates.poNumber : data[i][SHIP_COLS.PO_NUMBER - 1];
          const employee      = data[i][SHIP_COLS.EMPLOYEE - 1];
          const invSync = syncShipmentInventory_(id, finalBoxes, finalDate, employee, finalPlatform, finalCity, finalPo);
          inventoryWarning = !invSync.success
            ? "Inventory sync failed: " + invSync.message
            : invSync.unmapped.length
              ? "Not deducted from Inventory (no SKU mapping): " + invSync.unmapped.join(", ")
              : "";
        }

        return { success: true, inventoryWarning };
      }
    }
    return { success: false, message: "Shipment not found: " + id };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Set just the invoice number on an existing shipment (used by the Box Labels gate).
function setShipmentInvoiceNumber(id, invoiceNumber) {
  return updateShipment(id, { invoiceNumber: invoiceNumber });
}

// Soft-delete a shipment. Caller (client) must already enforce admin-only,
// but we double-check role here too as defense in depth.
/** Server-side re-check of module access, for actions (like deleting a
 *  shipment) where the client-side hasModule_() gate alone isn't enough
 *  — Apps Script has no persistent session, so anything destructive
 *  re-verifies against the EMPLOYEES sheet itself rather than trusting
 *  whatever role/module the client claims to have.
 *
 *  IMPORTANT: `role` is accepted for call-site compatibility but is
 *  NEVER trusted — it used to short-circuit to true for a claimed
 *  "admin" role without checking the sheet at all, which meant the
 *  admin bypass (the single highest-privilege case) was the one path
 *  this function DIDN'T actually verify. Every check now resolves the
 *  real row and its real ROLE/STATUS columns instead. */
function employeeHasModule_(name, role, moduleId) {
  const sheet = ensureEmployeesSheet_();
  const data = sheet.getDataRange().getValues();
  const nameLower = (name || "").trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim().toLowerCase() === nameLower) {
      const status = (data[i][3] || "enabled").toString().trim().toLowerCase();
      if (status === "disabled") return false;
      const actualRole = (data[i][2] || "employee").toString().trim().toLowerCase();
      if (actualRole === "admin") return true;
      const modules = (data[i][4] || "").toString().trim();
      return modules.split(",").map(s => s.trim()).includes(moduleId);
    }
  }
  return false;
}

/** True only if `name` is an enabled admin in the EMPLOYEES sheet RIGHT
 *  NOW — resolved fresh from the sheet every call, never from a
 *  client-supplied role string. Use this to gate actions that must be
 *  admin-only (employee management, SKU Master, warehouses, RO
 *  settings), the same way employeeHasModule_ gates module-based ones. */
function isRequesterAdmin_(name) {
  const sheet = ensureEmployeesSheet_();
  const data = sheet.getDataRange().getValues();
  const nameLower = (name || "").trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim().toLowerCase() === nameLower) {
      const status = (data[i][3] || "enabled").toString().trim().toLowerCase();
      if (status === "disabled") return false;
      return (data[i][2] || "employee").toString().trim().toLowerCase() === "admin";
    }
  }
  return false;
}

function deleteShipmentRecord(id, requesterName, requesterRole) {
  try {
    if (!employeeHasModule_(requesterName, requesterRole, "SHIPMENT_DELETE")) {
      return { success: false, message: "You do not have permission to delete shipments." };
    }
    const sheet = ensureShipmentsSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][SHIP_COLS.ID - 1] === id) {
        const entryDate = formatDateForCompare_(data[i][SHIP_COLS.DATE - 1]);
        const employee  = data[i][SHIP_COLS.EMPLOYEE - 1];
        const platform  = data[i][SHIP_COLS.PLATFORM - 1];
        const city      = data[i][SHIP_COLS.CITY - 1];
        const poNumber  = (data[i][SHIP_COLS.PO_NUMBER - 1] || "").toString().trim(); // MUST be stringified: a purely-numeric PO Number (e.g. Blinkit's long digit-only POs) can be stored as an actual Number by Sheets, and fullyCancelPo_ below does a strict string comparison against the PO sheet — comparing a raw number to a string never matches, silently canceling nothing
        const invoiceNumber = data[i][SHIP_COLS.INVOICE_NUMBER - 1];
        sheet.getRange(i + 1, SHIP_COLS.DELETED).setValue(true);
        // Permanently void this shipment's invoice number so it can
        // never be reused — a shipment that had a full RO Invoice was
        // already protected (that row in RO_INVOICES is untouched by a
        // delete), but a shipment with just a plain invoice number and
        // no formal RO Invoice was not, until now.
        if (invoiceNumber) recordCancelledInvoiceNumber_(invoiceNumber, id, "SHIPMENT_DELETED", requesterName);

        // Void this shipment's PO entirely (marks every line CANCELLED)
        // so a deleted shipment leaves nothing selectable in the New
        // Shipment dropdown — it does NOT silently reopen the PO for
        // reuse. Uses fullyCancelPo_, NOT validateAndUpdatePoShipped_ —
        // that function's monotonic-status rule (deliberately, for the
        // EDIT case) never lets a line go back to OPEN once FULFILLED.
        // See fullyCancelPo_ for why voiding on a full delete is safe.
        // Applies to any PO-driven platform (Blinkit, Zepto, Swiggy).
        const deletePlatformLower = (platform || "").toString().trim().toLowerCase();
        if (poPlatformConfig_(deletePlatformLower) && poNumber) {
          fullyCancelPo_(deletePlatformLower, poNumber);
        }

        // Give back everything this shipment had deducted from Inventory.
        const invRes = reverseShipmentInventory_(id, entryDate, employee, platform, city, poNumber);
        const inventoryWarning = invRes.success === false
          ? "Inventory reversal failed: " + invRes.error + " (stock was NOT restored — please retry or adjust manually)"
          : "";
        return { success: true, inventoryWarning };
      }
    }
    return { success: false, message: "Shipment not found: " + id };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ════════════════════════════════════════════════════════════════
//  BLINKIT / ZEPTO PO MANAGEMENT
//  Sheets: BLINKIT_PO, ZEPTO_PO (same 14-column layout)
// ════════════════════════════════════════════════════════════════

const PO_COLS = {
  PO_NUMBER:1, WAREHOUSE:2, UPLOAD_DATE:3, EXPIRY_DATE:4,
  UPLOADED_BY:5, ITEM_CODE:6, UPC:7, DESCRIPTION:8,
  MRP:9, LANDING_RATE:10, GST_PCT:11, PO_QTY:12,
  SHIPPED_QTY:13, STATUS:14,
  IS_DUMMY:15 // Blinkit-only "Dummy Order" flag set at PO upload time — see uploadBlinkitPo. Always blank/false for Zepto/Swiggy.
};

/** Every "PO-driven" platform (one where a PO is uploaded first, and
 *  shipments are then built by picking SKUs FROM that PO) is registered
 *  here with its own PO sheet and its own SKU_MASTER item-id field.
 *  validateAndUpdatePoShipped_, getPoFulfillmentMap_impl_, and the
 *  unmapped-SKU helpers below are all written generically against this
 *  config instead of being duplicated per platform — adding a third
 *  PO-driven platform later means adding one entry here plus its own
 *  parser/upload/list functions, not touching the shared logic. */
const PO_PLATFORM_CONFIG = {
  blinkit: { sheetName: SHEET_BLINKIT_PO, itemIdField: 'blinkitItemId' },
  zepto:   { sheetName: SHEET_ZEPTO_PO,   itemIdField: 'zeptoItemId'  },
  swiggy:  { sheetName: SHEET_SWIGGY_PO,  itemIdField: 'swiggyItemId' }
};
function poPlatformConfig_(platform) {
  return PO_PLATFORM_CONFIG[(platform || '').toString().trim().toLowerCase()] || null;
}

/** platform defaults to 'blinkit' so every existing call site (written
 *  before Zepto PO support existed) keeps working unchanged. */
function ensurePoSheet_(platform) {
  const cfg = poPlatformConfig_(platform || 'blinkit') || PO_PLATFORM_CONFIG.blinkit;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(cfg.sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(cfg.sheetName);
    sheet.appendRow([
      "PO_NUMBER","WAREHOUSE","UPLOAD_DATE","EXPIRY_DATE","UPLOADED_BY",
      "ITEM_CODE","UPC","DESCRIPTION","MRP","LANDING_RATE","GST_PCT",
      "PO_QTY","SHIPPED_QTY","STATUS","IS_DUMMY"
    ]);
  } else if (sheet.getLastColumn() < PO_COLS.IS_DUMMY) {
    // Self-heal: PO sheets created before the Dummy Order feature existed
    // are missing this column — add the header so new uploads have
    // somewhere to write it. Existing rows are simply blank (falsy) there.
    sheet.getRange(1, PO_COLS.IS_DUMMY).setValue("IS_DUMMY");
  }
  return sheet;
}

function toDateString_(val) {
  if (!val) return "";
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth()+1).padStart(2,"0");
    const d = String(val.getDate()).padStart(2,"0");
    return y+"-"+m+"-"+d;
  }
  return String(val);
}

/** Parse plain text (extracted by PDF.js in the browser) from a Blinkit RO PDF.
 *
 *  We only need two things per item: the Item Code and the Qty — Item Code
 *  is exactly what SKU_MASTER's BLINKIT column stores, so it's what we
 *  match against later (not the barcode/UPC, which we no longer bother
 *  extracting at all).
 *
 *  The app's own extractPdfText_ (client-side) groups text items by
 *  y-coordinate into lines, then joins lines with spaces. That means the
 *  item's FIRST visual line — serial, Item Code, the first fragment of
 *  HSN/UPC, the start of the product description, AND its full numeric
 *  block (IGST%, CESS%, Tax Amt, Landing Rate, Qty, MRP, Total Amt) — all
 *  land on one text line, space-separated, while the wrapped remainder of
 *  the description (and the oddly per-character-per-line "ADDT.CESS"
 *  column) spill onto later lines we don't need to touch. So the primary
 *  strategy here is simply: find each such line, and read Qty as the 3rd
 *  number from the end of it (Landing Rate, Qty, MRP, Total Amt is always
 *  the trailing order).
 *
 *  PDF.js layout isn't perfectly consistent across every PDF/version
 *  though — some extractions collapse whitespace entirely instead of
 *  preserving lines (columns glued into one run of characters with no
 *  separators at all). For that case we fall back to a second strategy
 *  that recovers Qty from Total Amt = Landing Rate × Qty using the
 *  decimal points, which survive extraction more reliably than spaces.
 */
function parseBlinkitRoPdf_(rawText) {
  try {
    const text = rawText.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
    const poMatch = text.match(/R\.O\.?\s*Number\s*[:\-]\s*(\d{10,16})/i);
    if (!poMatch) return { success:false, message:"Could not find the R.O. Number in the extracted text. Please check the file is the correct Blinkit PO PDF." };
    const poNumber = poMatch[1].trim();
    // "date" sometimes lands on a different line than "R.O. expiry" itself
    // (column-header word-wrap artifacts), so don't require them adjacent —
    // just look for the date value within a short window after "expiry".
    const expiryMatch = text.match(/R\.O\.?\s*expiry\b[\s\S]{0,20}?:\s*([A-Za-z]+\.?\s+\d{1,2},?\s*\d{4})/i);
    const expiryDate = expiryMatch ? expiryMatch[1].trim() : "";

    let rows = parseRoRowsByLine_(text);
    if (!rows.length) rows = parseRoRowsByGluedAnchor_(text);

    rows.sort((a,b)=>a.itemCode.localeCompare(b.itemCode));
    if (!rows.length) return {success:false,message:"PDF text extracted but no item rows could be parsed. Raw text shown below.",poNumber,expiryDate,rawText:text.slice(0,3000)};
    return {success:true,poNumber,expiryDate,rows};
  } catch(err) {
    return {success:false,message:"Parse error: "+err.message};
  }
}

/** Primary strategy: one line per item, e.g.
 *  " 1   10254670   42033 74217751 Travalate 2-  18.00 0.00 0. 39.66 260.00 100 1299.00 26000.00"
 *  Item Code is anchored directly (serial + Item Code + HSN-first-chunk +
 *  UPC-first-chunk), then Qty is read as the 3rd-from-last number on that
 *  same line — Landing Rate, Qty, MRP, Total Amt is always the trailing
 *  order, regardless of how much description text precedes the numbers. */
/** Some R.O. PDFs (observed on the Jaipur warehouse's layout) render the
 *  Item Code column one character narrower than usual, so its LAST digit
 *  wraps onto the row's continuation line instead of staying on the main
 *  line — landing right in front of that line's other wrapped fragments
 *  (HSN's last 3 digits, UPC's last 5 digits, description continuation).
 *  Item Codes are always 8 digits (10 + 6 more), so a 7-digit capture on
 *  the main line means this wrap happened; the continuation line's very
 *  first token (a lone digit followed by non-digit content) is that
 *  missing 8th digit. Every other field needed (Qty, Landing Rate, Total
 *  Amt) already lives complete on the main line regardless, so nothing
 *  else about the existing per-line strategy needs to change. */
function parseRoRowsByLine_(text) {
  const lines = text.split('\n');
  const lineRe = /^\s*\d{1,2}\s+(10\d{5,6})\s+\d{5}\s+\d{7,8}\s+(.*)$/;
  const wrappedDigitRe = /^\s*(\d)(?=\D|$)/;
  const rows = [];
  lines.forEach((line, idx) => {
    const m = line.match(lineRe);
    if (!m) return;
    let itemCode = m[1];
    if (itemCode.length === 7) {
      const cm = (lines[idx + 1] || '').match(wrappedDigitRe);
      if (cm) itemCode += cm[1];
    }
    if (itemCode.length !== 8) return; // still incomplete — don't guess further
    const nums = (m[2].match(/\d+\.\d+|\d+/g) || []).map(Number);
    if (nums.length < 5) return;
    const landingRate = nums[nums.length - 4];
    const qty = Math.round(nums[nums.length - 3]);
    const totalAmt = nums[nums.length - 1];
    // Sanity-check against the invoice arithmetic (Total Amt = Landing
    // Rate × Qty) so a row with unexpected extra numbers earlier in the
    // description doesn't silently produce a wrong Qty.
    const expected = landingRate * qty;
    if (qty > 0 && landingRate > 0 && Math.abs(expected - totalAmt) < Math.max(1, totalAmt * 0.02)) {
      if (!rows.find(r => r.itemCode === itemCode)) rows.push({ itemCode, qty });
    }
  });
  return rows;
}

/** Fallback strategy for when PDF.js collapses whitespace entirely instead
 *  of preserving line structure (columns glued into one run of characters
 *  with zero separators). Anchors on Item Code + HSN + UPC glued together
 *  with no leading serial number — deliberately NOT capturing the row's
 *  serial digit(s), since when a row runs straight into the next with no
 *  paragraph break, a leading serial capture can "steal" trailing digits
 *  off the PREVIOUS row's Total Amt. Then recovers Qty from
 *  Total Amt = Landing Rate × Qty using decimal points, which survive
 *  extraction more reliably than spaces do. */
function parseRoRowsByGluedAnchor_(text) {
  const startIdx = text.search(/#\s*Item\s*Code/i);
  const endIdx = text.search(/Total\s*Quantity\s*:/i);
  const tableText = (startIdx >= 0 ? text.slice(startIdx) : text)
    .slice(0, endIdx >= 0 ? (endIdx - (startIdx >= 0 ? startIdx : 0)) : undefined);

  const rowRe = /(10\d{6})\s*(\d{5}\s*\d{3})\s*(742177\d{1,2}\s*\d{3,4})/g;
  const anchors = [];
  let m;
  while ((m = rowRe.exec(tableText)) !== null) {
    anchors.push({ matchStart: m.index, matchEnd: m.index + m[0].length, itemCode: m[1] });
  }

  const rows = [];
  for (let a = 0; a < anchors.length; a++) {
    const cur = anchors[a];
    const chunkEnd = a + 1 < anchors.length ? anchors[a+1].matchStart : tableText.length;
    let chunk = tableText.slice(cur.matchEnd, chunkEnd);

    // The NEXT row's serial number always leaks onto the tail of this
    // chunk (glued on with zero separator, or just separated by a
    // newline) since we stopped anchoring on it. We know its exact
    // expected value (row a+2, 1-indexed) so we can strip it precisely
    // instead of guessing.
    if (a + 1 < anchors.length) {
      const nextSerial = String(a + 2);
      chunk = chunk.replace(new RegExp('\\s*' + nextSerial.replace(/\d/g, '\\$&') + '\\s*$'), '');
    }

    const qty = extractQtyFromRowChunk_(chunk);
    if (cur.itemCode && qty > 0 && !rows.find(r => r.itemCode === cur.itemCode)) {
      rows.push({ itemCode: cur.itemCode, qty });
    }
  }
  return rows;
}

/** Recovers Qty from one row's trailing numeric block using
 *  Total Amt = Landing Rate × Qty, reading Landing Rate and Total Amt off
 *  their decimal points (the last 4 periods in the chunk: TaxAmt's,
 *  LandingRate's, MRP's, TotalAmt's — in that fixed column order) rather
 *  than trying to isolate Qty's digits directly, which is ambiguous when
 *  Qty is glued straight onto MRP with no separator.
 *  Tries both 1- and 2-decimal-digit interpretations at each boundary,
 *  because Blinkit occasionally prints a trailing-zero-free amount like
 *  "71.7" instead of "71.70", which would otherwise misalign every field
 *  after it. Returns 0 if no interpretation resolves to a clean qty. */
function extractQtyFromRowChunk_(chunk) {
  const dots = [];
  for (let i = 0; i < chunk.length; i++) if (chunk[i] === '.') dots.push(i);
  if (dots.length < 4) return 0;
  const d = dots.slice(-4); // [TaxAmt, LandingRate, MRP, TotalAmt] dots, in order
  const segBeforeLanding = chunk.slice(d[0]+1, d[1]).replace(/\s+/g,''); // TaxAmt's decimals + LandingRate's integer part
  const segBeforeMrp     = chunk.slice(d[1]+1, d[2]).replace(/\s+/g,''); // LandingRate's decimals + (ambiguous Qty+MRP-integer, unused)
  const segBeforeTotal   = chunk.slice(d[2]+1, d[3]).replace(/\s+/g,''); // MRP's decimals + TotalAmt's integer part
  const afterTotal       = chunk.slice(d[3]+1).replace(/\s+/g,'');       // TotalAmt's decimals

  let best = 0, bestIsStandard = false;
  for (const skipTax of [2,1]) {
    if (segBeforeLanding.length <= skipTax) continue;
    const landingInt = segBeforeLanding.slice(skipTax);
    for (const skipLanding of [2,1]) {
      if (segBeforeMrp.length < skipLanding) continue;
      const landingRate = parseFloat(landingInt + '.' + segBeforeMrp.slice(0, skipLanding));
      if (!landingRate) continue;
      for (const skipMrp of [2,1]) {
        if (segBeforeTotal.length <= skipMrp) continue;
        const totalInt = segBeforeTotal.slice(skipMrp);
        for (const decLen of [2,1]) {
          if (afterTotal.length < decLen) continue;
          const totalAmt = parseFloat(totalInt + '.' + afterTotal.slice(0, decLen));
          if (!totalAmt) continue;
          const qtyRaw = totalAmt / landingRate;
          const qty = Math.round(qtyRaw);
          const isStandard = skipTax===2 && skipLanding===2 && skipMrp===2 && decLen===2;
          if (qty > 0 && qty < 100000 && Math.abs(qtyRaw - qty) < 0.03) {
            // Prefer the standard (both-decimals-are-2-digits) interpretation
            // when it's valid; otherwise take the first valid fallback found.
            if (isStandard) return qty;
            if (!best) { best = qty; bestIsStandard = isStandard; }
          }
        }
      }
    }
  }
  return best;
}

/** Set of every Item Code that currently has a SKU mapping for the given
 *  platform (SKU_MASTER's BLINKIT_ITEM_ID or ZEPTO_ITEM_ID column) — i.e.
 *  an employee packing a shipment would actually be able to select a SKU
 *  that resolves to this Item Code. Used to flag PO line items that have
 *  no corresponding SKU_MASTER row yet, so ops can add the mapping
 *  BEFORE employees start packing that PO (otherwise that line item is
 *  invisible to the SKU dropdown and can never be fulfilled through the
 *  normal box-building flow). platform defaults to 'blinkit'. */
function getKnownItemIdSet_(platform) {
  const cfg = poPlatformConfig_(platform || 'blinkit') || PO_PLATFORM_CONFIG.blinkit;
  const set = new Set();
  getSkuData().forEach(s => { if (s[cfg.itemIdField]) set.add(s[cfg.itemIdField].toString().trim()); });
  return set;
}

/** Cross-references parsed PO rows against SKU_MASTER and returns the
 *  subset with no item-id mapping at all for that platform, in
 *  {itemCode,qty} shape ready to hand back to the client for display. */
function findUnmappedPoItemCodes_(rows, platform) {
  const knownIds = getKnownItemIdSet_(platform);
  return (rows||[]).filter(r => !knownIds.has(r.itemCode)).map(r => ({itemCode:r.itemCode, qty:r.qty}));
}

/** PO-NUMBER-LEVEL duplicate guard. Replaces the old per-Item-Code
 *  dedupe (which silently added whatever "new" item codes it found and
 *  only blocked if literally every item code already existed — so a
 *  slightly-different re-export of the same PO could sneak in extra
 *  rows). A PO Number is either fresh or it isn't: if ANY row already
 *  exists for it, the upload is rejected outright, no partial add.
 *  Distinguishes "Already Fulfilled" (every line closed AND a POD is on
 *  file), "Already Packed" (every line closed but no POD yet), and
 *  "Already Uploaded" (still OPEN/PARTIAL) so the warning tells the
 *  employee what actually happened to it. */
function checkPoAlreadyUploaded_(sheet, poNumber, platform) {
  const data = sheet.getDataRange().getValues();
  let found = false, allFulfilled = true;
  for (let i=1;i<data.length;i++) {
    if ((data[i][PO_COLS.PO_NUMBER-1]||"").toString().trim()!==poNumber) continue;
    const rowStatus = (data[i][PO_COLS.STATUS-1]||"").toString().trim().toUpperCase();
    if (rowStatus==="CANCELLED") continue; // voided rows don't block a fresh re-upload
    found = true;
    if (rowStatus!=="FULFILLED") allFulfilled = false;
  }
  if (!found) return {duplicate:false};
  let label = 'Uploaded';
  if (allFulfilled) label = (platform && isPoPodUploaded_(platform, poNumber)) ? 'Fulfilled' : 'Packed';
  return {duplicate:true, message:'PO ' + poNumber + ' is Already ' + label + '.'};
}

/** Server receives the plain text already extracted by PDF.js in the browser.
 *  No DriveApp needed — avoids permission errors entirely. */
function parsePoPdfBytes(rawText) {
  try {
    const parsed = parseBlinkitRoPdf_(rawText||"");
    if (!parsed.success) { parsed.rawText=(rawText||"").slice(0,3000); return parsed; }
    parsed._rawText = rawText;
    // Flag any Item Code in this PO that isn't mapped in SKU_MASTER yet,
    // so the upload preview can warn before the PO is even saved.
    parsed.unmappedItemCodes = findUnmappedPoItemCodes_(parsed.rows, 'blinkit');
    return parsed;
  } catch(err) { return {success:false,message:"Parse error: "+err.message}; }
}

function uploadBlinkitPo(params) {
  try {
    const parsed = parseBlinkitRoPdf_(params.rawText||"");
    if (!parsed.success) return parsed;
    const {poNumber,expiryDate,rows} = parsed;
    const warehouse = getWarehouseByName_(params.warehouseName);
    if (!warehouse) return {success:false,message:'Warehouse "'+params.warehouseName+'" not found. Please add it first.'};
    const sheet = ensurePoSheet_('blinkit');
    const dupCheck = checkPoAlreadyUploaded_(sheet, poNumber, 'blinkit');
    if (dupCheck.duplicate) return {success:false,message:dupCheck.message};
    const uploadDate = toDateString_(new Date());
    const uploadedBy = (params.uploadedBy||"").trim();
    // The UPC column is kept for schema/backward-compat reasons but now
    // just holds the Item Code too — Item Code is what SKU_MASTER's
    // BLINKIT column actually stores, so it's the value everything
    // downstream (checkSkuInPo_, checkPoQtyAcrossBoxes_, shipped-qty
    // deduction) matches shipment items against.
    // Dummy Order: a PO uploaded purely to get an RO Invoice from, never
    // a real fulfillment — see uploadBlinkitPo's own IS_DUMMY column and
    // createDummyRoInvoice_impl_ for what changes downstream once a
    // shipment is built against it.
    const isDummy = !!params.isDummy;
    const newRows = rows.map(r => [poNumber,params.warehouseName,uploadDate,expiryDate,uploadedBy,r.itemCode,r.itemCode,"",0,0,0,r.qty,0,"OPEN",isDummy]);
    if (!newRows.length) return {success:false,message:'PO '+poNumber+' has no item rows to upload.'};
    sheet.getRange(sheet.getLastRow()+1,1,newRows.length,newRows[0].length).setValues(newRows);
    invalidateOpenPosCache_('blinkit');
    // Still saved even if some Item Codes aren't mapped yet — the PO's
    // quantities need to be on record regardless, but flag them so ops
    // can add the SKU_MASTER mapping (BLINKIT_ITEM_ID column) and those items
    // become packable without needing to re-upload the PO itself.
    const unmappedItemCodes = findUnmappedPoItemCodes_(rows, 'blinkit');
    return {success:true,poNumber,rowsAdded:newRows.length,totalRows:rows.length,unmappedItemCodes};
  } catch(err) { return {success:false,message:err.message}; }
}

// ════════════════════════════════════════════════════════════════
//  ZEPTO PO PARSING
// ════════════════════════════════════════════════════════════════

/** Parse plain text (extracted by PDF.js in the browser) from a Zepto
 *  Purchase Order PDF.
 *
 *  Zepto's PO table columns (left to right) are: Sr | Material Code |
 *  Item Description | SKU Code (an internal UUID, not used here) | HSN
 *  Code | EAN No | Quantity | MRP/RSP | Unit Base Cost | Taxable Value |
 *  CGST/SGST/IGST/CESS rate+amount pairs | Total(INR).
 *
 *  Only Material Code and Quantity are pulled out — Material Code is
 *  what gets matched against SKU_MASTER's ZEPTO_ITEM_ID column later,
 *  mirroring how Blinkit's Item Code works for Blinkit POs.
 *
 *  NOTE: this is a FIRST-PASS parser built from a single sample PO, not
 *  refined against real-world PDF.js output the way the Blinkit parser
 *  above was (see its extensive quirk comments — that one only reached
 *  its current form after several rounds of fixes against actual
 *  extracted text). If a real upload fails to find rows, or finds the
 *  wrong ones, the raw extracted text is always returned for manual
 *  review (see parseZeptoPoPdfBytes) so nothing is silently lost — please
 *  test against a couple of real Zepto POs and report back anything
 *  that comes out wrong so the extraction can be tightened up the same
 *  way Blinkit's was. */
function parseZeptoPo_(rawText) {
  try {
    const text = rawText.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
    const poMatch = text.match(/PO\s*No\.?\s*:?\s*([A-Za-z0-9\-\/]+)/i);
    if (!poMatch) return { success:false, message:"Could not find the PO No. in the extracted text. Please check the file is the correct Zepto PO PDF." };
    const poNumber = poMatch[1].trim();
    const expiryMatch = text.match(/PO\s*Expiry\s*Date\s*:?\s*(\d{4}-\d{2}-\d{2})/i);
    const expiryDate = expiryMatch ? expiryMatch[1].trim() : "";

    const rows = parseZeptoRows_(text);
    if (!rows.length) return {success:false,message:"PDF text extracted but no item rows could be parsed. Raw text shown below.",poNumber,expiryDate,rawText:text.slice(0,3000)};
    return {success:true,poNumber,expiryDate,rows};
  } catch(err) {
    return {success:false,message:"Parse error: "+err.message};
  }
}

/** Real extracted text from actual Zepto PO uploads shows PDF.js keeps
 *  Sr, Material Code, and the full amounts tail (Quantity, MRP, Unit
 *  Base Cost, Taxable Value, and every rate/amount/Total column)
 *  together on ONE single backbone line — the same behavior already
 *  confirmed for Swiggy's PDFs (see parseSwiggyRows_'s comment for the
 *  full story). Only the free-text Item Description, the SKU Code (an
 *  internal UUID, unused here), and sometimes even the EAN No drift
 *  onto separate line(s) around that backbone, in no fixed position —
 *  one real PO had EAN sitting on the SAME line right after Material
 *  Code, another had it on its OWN line entirely before the Sr/backbone
 *  line. Description text itself can also contain stray numbers (e.g.
 *  "...Up to 50 kg Capacity" right before the HSN Code), which rules
 *  out anchoring on "the next lone number after Material Code".
 *
 *  BUG HISTORY:
 *  v1 recovered Material Code and EAN/Quantity as two separate
 *  whole-text regex passes zipped by nearest-preceding-index, requiring
 *  Material Code to be immediately followed by a letter — broke when
 *  Description drifted away and HSN Code (digits) followed Material
 *  Code instead.
 *  v2 anchored on the EAN barcode ("742177...") immediately followed by
 *  Quantity on the same line — broke on PO layouts where EAN sits on
 *  its own separate line, nowhere near Quantity.
 *  v3 anchored on Quantity immediately followed by three
 *  decimal-formatted amounts (MRP, Unit Base Cost, Taxable Value) on
 *  the SAME line — broke on two further real layouts: (a) a lone Sr
 *  digit landing on its own line, split from Material Code by only ~2pt
 *  of vertical drift in the PDF (too small a gap for extractPdfText_'s
 *  Y-rounding to treat as the same line), leaving Material Code to
 *  start a line with no Sr before it; (b) a whole row split across TWO
 *  physically different lines — Material Code + Taxable Value ending up
 *  on the line ABOVE, Sr + EAN + Quantity + MRP + Unit Base Cost on the
 *  line the Sr number is actually on — the same root cause as (a), just
 *  a bigger chunk of the row affected.
 *
 *  FIX: preprocessZeptoRowLines_ first stitches these split lines back
 *  together (see its own comment), THEN the same Quantity-followed-by-
 *  three-decimals anchor from v3 runs against the repaired lines. Also
 *  hardened that anchor with a leading \b: without it, a lazy scan could
 *  match a tail FRAGMENT of a longer digit run (e.g. "021110", the last
 *  six digits of HSN Code "42021110") as if it were Quantity, whenever
 *  that fragment happened to be followed by three decimals of its own —
 *  which happened for real once rows started getting stitched back
 *  together and HSN Code ended up sitting directly before Taxable
 *  Value/IGST/Total with no genuine Quantity in between them yet. */
function preprocessZeptoRowLines_(lines) {
  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Case A: this line is NOTHING but a bare Sr number — its Material
    // Code landed on the NEXT line instead of alongside it. Only merge
    // when that next line actually starts with something Material-Code
    // shaped, so this can't misfire on, say, a numbered terms-and-
    // conditions clause ("7." followed by prose) elsewhere in the PDF.
    if (/^\s*\d{1,3}\s*$/.test(line) && i + 1 < lines.length && /^\s*\d{4,10}\b/.test(lines[i + 1])) {
      merged.push(line.trim() + ' ' + lines[i + 1]);
      i++; // consumed lines[i+1] too
      continue;
    }
    // Case B: this line starts with a Sr number immediately followed by
    // an EAN (always the "742177" prefix for Travalate's own barcodes)
    // rather than a Material Code — Material Code (and often Taxable
    // Value / other amount columns) leaked onto the PRECEDING line
    // instead. Pull that previous line down onto this one.
    if (/^\s*\d{1,3}\s+742177\d{6}\b/.test(line) && merged.length) {
      merged[merged.length - 1] += ' ' + line;
      continue;
    }
    merged.push(line);
  }
  return merged;
}
function parseZeptoRows_(text) {
  const lines = preprocessZeptoRowLines_(text.split('\n'));
  const lineRe = /^\s*(?:\d{1,3}\s+)?(\d{4,10})\b.*?\b(\d{1,6})\s+\d+\.\d{2}\s+\d+\.\d{2}\s+\d+\.\d{2}/;
  const rows = [];
  const seen = new Set();
  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const itemCode = m[1];
    const qty = parseInt(m[2], 10);
    if (!itemCode || qty <= 0) continue;
    if (seen.has(itemCode)) continue; // dedupe if the same item somehow matches twice
    seen.add(itemCode);
    rows.push({ itemCode, qty });
  }
  if (rows.length) { rows.sort((a,b)=>a.itemCode.localeCompare(b.itemCode)); return rows; }
  return parseZeptoRowsCrossLine_(text);
}


/** Original cross-line strategy — kept as a fallback for whatever
 *  layout it was first built against. Anchors on the EAN barcode
 *  immediately followed by Quantity, then separately recovers Material
 *  Code as the first standalone 6-10 digit integer right after each
 *  row's Sr number and right before the free-text description begins,
 *  zipping the two together by nearest-preceding-index. */
function parseZeptoRowsCrossLine_(text) {
  const eanQtyRe = /742177\d{6}\s+(\d{1,6})(?=\s|$)/g;
  const qtyMatches = [];
  let m;
  while ((m = eanQtyRe.exec(text)) !== null) {
    qtyMatches.push({ qty: parseInt(m[1],10), index: m.index });
  }
  if (!qtyMatches.length) return [];

  const codeRe = /(?:^|\s)\d{1,3}\s+(\d{6,10})\s+(?=[A-Za-z])/g;
  const codeMatches = [];
  while ((m = codeRe.exec(text)) !== null) {
    codeMatches.push({ itemCode: m[1], index: m.index });
  }

  const rows = [];
  const seen = new Set();
  for (let i = 0; i < qtyMatches.length; i++) {
    // This row's Material Code is the LAST code-match occurring BEFORE
    // this EAN/Quantity match's position in the text.
    let itemCode = null;
    for (let j = codeMatches.length - 1; j >= 0; j--) {
      if (codeMatches[j].index < qtyMatches[i].index) { itemCode = codeMatches[j].itemCode; break; }
    }
    if (!itemCode || qtyMatches[i].qty <= 0) continue;
    if (seen.has(itemCode)) continue; // dedupe if the same item somehow matches twice
    seen.add(itemCode);
    rows.push({ itemCode, qty: qtyMatches[i].qty });
  }
  rows.sort((a,b)=>a.itemCode.localeCompare(b.itemCode));
  return rows;
}

/** Preview step — mirrors parsePoPdfBytes. Server receives the plain
 *  text already extracted by PDF.js in the browser. */
function parseZeptoPoPdfBytes(rawText) {
  try {
    const parsed = parseZeptoPo_(rawText||"");
    if (!parsed.success) { parsed.rawText=(rawText||"").slice(0,3000); return parsed; }
    parsed._rawText = rawText;
    parsed.unmappedItemCodes = findUnmappedPoItemCodes_(parsed.rows, 'zepto');
    return parsed;
  } catch(err) { return {success:false,message:"Parse error: "+err.message}; }
}

/** Mirrors uploadBlinkitPo — see its comments for the shared reasoning
 *  (UPC column doubling as Item Code, unmapped-item-code flagging,
 *  dedupe-by-existing-Item-Code logic). */
function uploadZeptoPo(params) {
  try {
    const parsed = parseZeptoPo_(params.rawText||"");
    if (!parsed.success) return parsed;
    const {poNumber,expiryDate,rows} = parsed;
    const warehouse = getWarehouseByName_(params.warehouseName);
    if (!warehouse) return {success:false,message:'Warehouse "'+params.warehouseName+'" not found. Please add it first.'};
    const sheet = ensurePoSheet_('zepto');
    const dupCheck = checkPoAlreadyUploaded_(sheet, poNumber, 'zepto');
    if (dupCheck.duplicate) return {success:false,message:dupCheck.message};
    const uploadDate = toDateString_(new Date());
    const uploadedBy = (params.uploadedBy||"").trim();
    const newRows = rows.map(r => [poNumber,params.warehouseName,uploadDate,expiryDate,uploadedBy,r.itemCode,r.itemCode,"",0,0,0,r.qty,0,"OPEN",false]); // Dummy Order is Blinkit-only — always false here
    if (!newRows.length) return {success:false,message:'PO '+poNumber+' has no item rows to upload.'};
    sheet.getRange(sheet.getLastRow()+1,1,newRows.length,newRows[0].length).setValues(newRows);
    invalidateOpenPosCache_('zepto');
    const unmappedItemCodes = findUnmappedPoItemCodes_(rows, 'zepto');
    return {success:true,poNumber,rowsAdded:newRows.length,totalRows:rows.length,unmappedItemCodes};
  } catch(err) { return {success:false,message:err.message}; }
}

// ════════════════════════════════════════════════════════════════
//  SWIGGY PO PARSING
// ════════════════════════════════════════════════════════════════

/** Parse plain text (extracted by PDF.js in the browser) from a Swiggy
 *  Instamart Purchase Order PDF — issued by "Jupiter Kart Private
 *  Limited" (Swiggy Instamart's registered PO entity; the PDF itself
 *  never says "Swiggy").
 *
 *  Swiggy's PO table columns (left to right) are: # | Item Code |
 *  Description | HSNCode | Qty | MRP | Unit Base Cost | Taxable Value |
 *  CGST rate+amt | SGST/UGST rate+amt | IGST rate+amt | CESS rate+amt |
 *  Additional Cess | Total (INR).
 *
 *  Only Item Code and Qty are pulled out — same scope as the Zepto
 *  parser above, and for the same reason (Landing Rate is entered
 *  manually into SKU_MASTER's SWIGGY_LANDING_PRICE column, not read off
 *  the PO).
 *
 *  NOTE: this is a FIRST-PASS parser built from a single sample PO —
 *  see parseZeptoPo_'s comment above for why (only Blinkit's parser has
 *  been hardened against real-world PDF.js quirks so far). If a real
 *  upload fails to find rows, or finds the wrong ones, the raw
 *  extracted text is always returned for manual review (see
 *  parseSwiggyPoPdfBytes) so nothing is silently lost — please test
 *  against a couple of real Swiggy POs and report back anything that
 *  comes out wrong so the extraction can be tightened up. */
/** The client sends Swiggy PDFs as a JSON array of [text,x,y] triples
 *  now (see extractPdfItemsJson_ in the HTML) rather than pre-joined
 *  text lines — see parseSwiggyRowsPositional_ for the full rationale.
 *  This detects that format and routes to the positional parser;
 *  anything else (a plain string, or JSON parsing failing for any
 *  reason) falls back to the legacy line-based parseSwiggyRows_ below,
 *  so this never becomes a hard dependency on the client having sent
 *  the new format. */
function parseSwiggyPo_(rawText) {
  try {
    const raw = (rawText||"").toString();
    let items = null;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length && Array.isArray(parsed[0])) items = parsed;
    } catch(e) { /* not JSON — legacy plain-text path below */ }

    let flatText, parsedRows;
    if (items) {
      // Reading order for the simple PO No./Expiry Date regex scans
      // below: top of page first (descending native y — PDF.js y
      // increases upward), left to right within a tie.
      flatText = items.slice().sort((a,b)=>b[2]-a[2] || a[1]-b[1]).map(it=>it[0]).join(' ');
      parsedRows = parseSwiggyRowsPositional_(items);
      if (!parsedRows) parsedRows = parseSwiggyRows_(flatText); // couldn't even find the "Qty" column header (e.g. an unrecognized template) — fall back rather than fail outright
    } else {
      flatText = raw.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
      parsedRows = parseSwiggyRows_(flatText);
    }
    const rows = parsedRows.rows;
    const skippedItemCodes = parsedRows.skipped || [];

    const poMatch = flatText.match(/PO\s*No\.?\s*:?\s*([A-Za-z0-9\-\/]+)/i);
    if (!poMatch) return { success:false, message:"Could not find the PO No. in the extracted text. Please check the file is the correct Swiggy PO PDF." };
    const poNumber = poMatch[1].trim();
    const expiryMatch = flatText.match(/PO\s*Expiry\s*Date\s*:?\s*(\d{4}-\d{2}-\d{2})/i);
    const expiryDate = expiryMatch ? expiryMatch[1].trim() : "";

    if (!rows.length) return {success:false,message:"PDF text extracted but no item rows could be parsed. Raw text shown below.",poNumber,expiryDate,rawText:flatText.slice(0,3000)};
    return {success:true,poNumber,expiryDate,rows,skippedItemCodes};
  } catch(err) {
    return {success:false,message:"Parse error: "+err.message};
  }
}

/** PERMANENT fix for the recurring "N-1 of N Swiggy PO items extracted"
 *  bug family. The flattened-text-plus-regex approach below
 *  (parseSwiggyRows_, still kept as a fallback and still used for
 *  Blinkit/Zepto) kept breaking on Swiggy PDFs because a single visual
 *  table row's Qty cell can land on a different exact baseline than the
 *  rest of the row, or a decimal value can get split across two
 *  separate text fragments — every such quirk needed its own regex
 *  patch (see the version history in parseSwiggyRows_'s comment), and
 *  each patch only fixed the one PDF it was written against.
 *
 *  This reads Qty directly from ITS OWN COLUMN instead: items is the
 *  raw [text,x,y] position of every piece of text PDF.js found on the
 *  page (native PDF coordinate space — y increases upward; the client
 *  pre-offsets each page's y so pages can never collide once flattened
 *  into one array). For each data row, Qty is simply whichever bare
 *  integer sits closest to the "Qty" header's X position — regardless
 *  of which line, baseline, or fragment it happened to land on. This is
 *  robust to every variant of the bug seen so far, and to variants that
 *  haven't shown up yet, because it was never depending on text
 *  layout/spacing in the first place.
 *
 *  Sr + Item Code detection is untouched from the original approach
 *  (leftmost Sr number immediately followed, left-to-right, by a 4-10
 *  digit code) — that part was never what broke; only Qty was.
 *
 *  Returns null (signaling the caller to fall back to parseSwiggyRows_)
 *  if the "Qty" header can't even be found — e.g. a template that
 *  doesn't say "Qty" at all — rather than guessing blindly. Otherwise
 *  returns {rows, skipped}: skipped lists any Item Code whose row was
 *  clearly identified (Sr + Item Code both found) but whose Qty
 *  couldn't be confidently located — so a row that's on the PO but
 *  didn't make it into the shipment is surfaced as a warning instead
 *  of silently vanishing, however rare that should now be. */
function parseSwiggyRowsPositional_(items) {
  const pts = items.map(it => ({t:String(it[0]), x:it[1], y:it[2]}));
  const qtyHeader = pts.find(p => p.t === 'Qty');
  if (!qtyHeader) return null;

  const sorted = pts.slice().sort((a,b) => b.y-a.y || a.x-b.x);

  // Cluster into visual rows with a Y-tolerance CHAIN: each item only
  // needs to be within STEP_TOL of the item immediately before it (not
  // the row's very first item), so a row's total baseline spread can
  // exceed STEP_TOL as long as it's made of small consecutive steps —
  // confirmed on PO GGNPO377787: ~2-5pt steps adding up to an ~8.6pt
  // total spread within one row, vs. a single ~19pt+ gap at every
  // genuine row boundary in the same PDF.
  const STEP_TOL = 6;
  const rows = [];
  let current = null;
  for (const p of sorted) {
    if (!current || (current.lastY - p.y) > STEP_TOL) {
      current = { items: [], lastY: p.y };
      rows.push(current);
    } else {
      current.lastY = p.y;
    }
    current.items.push(p);
  }

  const srRe = /^\d{1,3}$/;
  const itemCodeRe = /^\d{4,10}$/;
  const qtyRe = /^\d{1,4}$/;
  const MAX_QTY_COLUMN_DRIFT = 15; // pt — sanity cap only; every real Qty cell checked so far sits at 0pt drift from the header. Guards against ever silently grabbing an unrelated stray digit rather than genuinely locating Qty.

  const result = [];
  const skipped = [];
  const seen = new Set();
  for (const row of rows) {
    const rowSorted = row.items.slice().sort((a,b)=>a.x-b.x);
    const srIdx = rowSorted.findIndex(p => srRe.test(p.t));
    if (srIdx === -1) continue; // not a data row (header/totals/etc.)
    let itemCode = null;
    for (let k=srIdx+1; k<rowSorted.length; k++) {
      if (itemCodeRe.test(rowSorted[k].t)) { itemCode = rowSorted[k].t; break; }
      if (!/^\d/.test(rowSorted[k].t)) break; // hit non-numeric text before a code — this "row" isn't Sr+Item Code after all
    }
    if (!itemCode || seen.has(itemCode)) continue;

    let best=null, bestDist=Infinity;
    for (const p of row.items) {
      if (!qtyRe.test(p.t)) continue;
      const d = Math.abs(p.x - qtyHeader.x);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    const qty = best && bestDist<=MAX_QTY_COLUMN_DRIFT ? parseInt(best.t,10) : null;
    if (!qty || qty <= 0) { skipped.push(itemCode); continue; } // Sr+Item Code found, but Qty couldn't be confidently located — surface this instead of silently dropping it
    seen.add(itemCode);
    result.push({ itemCode, qty });
  }
  result.sort((a,b)=>a.itemCode.localeCompare(b.itemCode));
  return {rows: result, skipped};
}

/** LEGACY fallback — only reached now if the client couldn't send
 *  positional data (see parseSwiggyRowsPositional_ above, which is the
 *  primary path and fixes the underlying problem this patches around).
 *  Real extracted text from this PDF template (confirmed against an
 *  actual upload) shows PDF.js keeps Sr, Item Code, HSN Code, Qty, and
 *  every rate/amount/Total column together on ONE single line — that's
 *  the row's stable "backbone". Only the free-text Description (which
 *  can run to 2-3 lines) and the odd decimal number that wraps mid-
 *  value (e.g. "13716.19" → "13716." then "19" on the next line) drift
 *  onto adjacent lines around that backbone.
 *
 *  Crucially, Description does NOT reliably appear on the backbone line
 *  itself — on one row it sat right after Item Code ("918913  Travel
 *  Toiletry Bag...") and the regex could anchor on "Item Code followed
 *  by a letter". On the very next row, Description was pushed onto the
 *  line ABOVE instead, so Item Code was followed immediately by the
 *  HSN Code (digits, not a letter) — silently breaking that anchor and
 *  dropping the row entirely. That's the actual cause of the 1-of-2
 *  items bug.
 *
 *  Fix: read each row straight off its backbone line, matching
 *  Sr + Item Code first, then locating Qty independently within the
 *  rest of that same line — never assuming what (if anything) sits
 *  between Item Code and HSN Code.
 *
 *  Qty itself is located by anchoring on "a short integer sitting
 *  immediately before a properly-formatted two-decimal number" (e.g.
 *  "50 850.00" — Qty directly followed by MRP), NOT by counting a
 *  fixed number of digits after the HSN code. The old HSN-then-Qty
 *  approach silently mis-parsed as MRP itself whenever HSN and Qty
 *  ended up tightly kerned enough for PDF.js to drop the space between
 *  them (e.g. item 918913 in PO MBJPO84034 read Qty as 850 — the MRP —
 *  instead of the real Qty of 50). Anchoring on the Qty→MRP decimal
 *  boundary instead is far more distinctive and isn't thrown off by
 *  that spacing quirk; the negative lookbehind additionally rejects a
 *  false match starting right after some OTHER number's own decimal
 *  point (e.g. mistaking the "00" tail of "850.00" for a second, bogus
 *  Qty immediately before "274.32").
 *
 *  ANOTHER real quirk (confirmed on PO GGNPO377787, item 796035): the
 *  Qty cell itself can be pushed onto its own isolated line, entirely
 *  separate from the backbone. This happens when a row's Description
 *  wraps to 2 lines and the PDF's row-height/vertical-centering pushes
 *  Qty's exact baseline a fraction of a point off from the rest of the
 *  row (e.g. Item Code at y=296.88 but Qty at y=294.58) — close enough
 *  to look identical on the page, but just far enough for PDF.js's
 *  strict per-y-coordinate line grouping to split it into its own line
 *  with nothing else on it. Other rows in the very same PDF are
 *  unaffected (their Qty sits properly on the backbone), so this can't
 *  be "fixed" by only ever looking at nearby lines — it has to fall
 *  back to it. When the backbone has no Qty next to a decimal, this
 *  looks within that row's own block (the lines between the previous
 *  and next row's backbone) for a line that is NOTHING but a bare 1-4
 *  digit number. That's a safe signal: every other column value always
 *  carries a decimal point or a '%', and Description text always
 *  carries letters, so a completely bare numeric line this close to
 *  the row can only be its stray Qty cell. */
function parseSwiggyRows_(text) {
  const lines = text.split('\n');
  const rowStartRe = /^\s*\d{1,3}\s+(\d{4,10})\b/;
  const qtyRe = /(?<!\.)\b(\d{1,6})\s+\d+\.\d{2}\b/;
  const bareIntRe = /^\d{1,4}$/;

  // First pass: locate every row's backbone line so each row's search
  // window can be scoped to "closest to this backbone, not the row
  // before or after it" — required for the isolated-Qty fallback below
  // to never accidentally borrow a stray number from a neighboring row.
  const starts = [];
  for (let i=0;i<lines.length;i++) {
    const m = lines[i].match(rowStartRe);
    if (m) starts.push({lineIdx:i, itemCode:m[1]});
  }

  const rows = [];
  const skipped = [];
  const seen = new Set();
  for (let s=0; s<starts.length; s++) {
    const {lineIdx, itemCode} = starts[s];
    if (!itemCode || seen.has(itemCode)) continue;

    // 1) Normal case: Qty sits on the same backbone line as Sr+Item Code.
    const backboneRest = lines[lineIdx].slice(lines[lineIdx].match(rowStartRe)[0].length);
    const qtyMatch = backboneRest.match(qtyRe);
    let qty = qtyMatch ? parseInt(qtyMatch[1], 10) : null;

    // 2) Fallback: Qty landed on its own isolated line somewhere in
    //    this row's block. The block spans from the midpoint between
    //    this row and the previous one, to the midpoint between this
    //    row and the next — so a stray bare-digit line always gets
    //    attributed to whichever row's backbone it's actually closest
    //    to, never one further away.
    if (!qty) {
      const blockStart = s===0 ? 0 : Math.floor((starts[s-1].lineIdx + lineIdx)/2)+1;
      const blockEnd = s===starts.length-1 ? lines.length : Math.floor((lineIdx + starts[s+1].lineIdx)/2)+1;
      for (let j=blockStart; j<blockEnd; j++) {
        const trimmed = lines[j].trim();
        if (bareIntRe.test(trimmed)) { qty = parseInt(trimmed,10); break; }
      }
    }

    if (!itemCode || !qty || qty <= 0) { skipped.push(itemCode); continue; } // Sr+Item Code found, but Qty couldn't be confidently located — surface this instead of silently dropping it
    seen.add(itemCode);
    rows.push({ itemCode, qty });
  }
  rows.sort((a,b)=>a.itemCode.localeCompare(b.itemCode));
  return {rows, skipped};
}

/** Preview step — mirrors parseZeptoPoPdfBytes. Server receives the
 *  plain text already extracted by PDF.js in the browser. */
function parseSwiggyPoPdfBytes(rawText) {
  try {
    const parsed = parseSwiggyPo_(rawText||"");
    if (!parsed.success) { parsed.rawText=(rawText||"").slice(0,3000); return parsed; }
    parsed._rawText = rawText;
    parsed.unmappedItemCodes = findUnmappedPoItemCodes_(parsed.rows, 'swiggy');
    return parsed;
  } catch(err) { return {success:false,message:"Parse error: "+err.message}; }
}

/** Mirrors uploadZeptoPo — see its comments (and uploadBlinkitPo's,
 *  which they in turn mirror) for the shared reasoning (UPC column
 *  doubling as Item Code, unmapped-item-code flagging, dedupe-by-
 *  existing-Item-Code logic). */
function uploadSwiggyPo(params) {
  try {
    const parsed = parseSwiggyPo_(params.rawText||"");
    if (!parsed.success) return parsed;
    const {poNumber,expiryDate,rows,skippedItemCodes} = parsed;
    const warehouse = getWarehouseByName_(params.warehouseName);
    if (!warehouse) return {success:false,message:'Warehouse "'+params.warehouseName+'" not found. Please add it first.'};
    const sheet = ensurePoSheet_('swiggy');
    const dupCheck = checkPoAlreadyUploaded_(sheet, poNumber, 'swiggy');
    if (dupCheck.duplicate) return {success:false,message:dupCheck.message};
    const uploadDate = toDateString_(new Date());
    const uploadedBy = (params.uploadedBy||"").trim();
    const newRows = rows.map(r => [poNumber,params.warehouseName,uploadDate,expiryDate,uploadedBy,r.itemCode,r.itemCode,"",0,0,0,r.qty,0,"OPEN",false]); // Dummy Order is Blinkit-only — always false here
    if (!newRows.length) return {success:false,message:'PO '+poNumber+' has no item rows to upload.'};
    sheet.getRange(sheet.getLastRow()+1,1,newRows.length,newRows[0].length).setValues(newRows);
    invalidateOpenPosCache_('swiggy');
    const unmappedItemCodes = findUnmappedPoItemCodes_(rows, 'swiggy');
    return {success:true,poNumber,rowsAdded:newRows.length,totalRows:rows.length,unmappedItemCodes,skippedItemCodes};
  } catch(err) { return {success:false,message:err.message}; }
}

/** A PO now has three "still visible in the dropdown" phases instead of
 *  the old binary OPEN→(removed once FULFILLED):
 *    OPEN/PARTIAL → PACKED (Generate Output has closed every line to
 *    FULFILLED, but no POD photo has been uploaded yet) → removed
 *    entirely only once a POD exists for that PO. This mirrors
 *    isPoFullyFulfilled_/getPoFulfillmentMap_impl_'s "fulfilled" flag
 *    (all lines FULFILLED) but adds the POD check on top so a packed-
 *    but-undelivered PO stays visible for reference until POD is
 *    actually uploaded — see isPoPodUploaded_. */
/** A PO now has three "still visible in the dropdown" phases instead of
 *  the old binary OPEN→(removed once FULFILLED):
 *    OPEN/PARTIAL → PACKED (Generate Output has closed every line to
 *    FULFILLED, but no POD photo has been uploaded yet) → removed
 *    entirely only once a POD exists for that PO. This mirrors
 *    isPoFullyFulfilled_/getPoFulfillmentMap_impl_'s "fulfilled" flag
 *    (all lines FULFILLED) but adds the POD check on top so a packed-
 *    but-undelivered PO stays visible for reference until POD is
 *    actually uploaded — see isPoPodUploaded_.
 *
 *  PERFORMANCE: this used to do a full getDataRange().getValues() over
 *  the entire PO sheet (every OPEN/PACKED/FULFILLED/CANCELLED row ever
 *  uploaded, which only grows over time) PLUS a full PO_POD sheet scan,
 *  on every single platform switch or dropdown refresh — this is what
 *  was making the dropdown visibly slow to populate, especially right
 *  after the day's first login when nothing had warmed up yet. Results
 *  are now cached (see openPosCache_get_/openPosCache_put_) and served
 *  straight from cache on repeat calls; the actual sheet-scanning logic
 *  moved to getOpenPosForPlatform_uncached_ below, called only on a
 *  cache miss. The cache is explicitly invalidated (see
 *  invalidateOpenPosCache_) by every action that can change a PO's
 *  dropdown status: uploading a new PO, Generate Output closing one
 *  out, deleting a shipment (which voids its PO), and uploading a POD —
 *  so results stay correct in real time despite the cache. */
function getOpenPosForPlatform_(platform) {
  const cached = openPosCache_get_(platform);
  if (cached) return cached;
  const result = getOpenPosForPlatform_uncached_(platform);
  openPosCache_put_(platform, result);
  return result;
}

function getOpenPosForPlatform_uncached_(platform) {
  const sheet = ensurePoSheet_(platform);
  const data = sheet.getDataRange().getValues();
  const map = {};
  for (let i=1;i<data.length;i++) {
    const status=(data[i][PO_COLS.STATUS-1]||"").toString().trim().toUpperCase();
    if (status==="CANCELLED") continue; // voided by a shipment delete — never selectable again
    const poNum=(data[i][PO_COLS.PO_NUMBER-1]||"").toString().trim();
    if (!poNum) continue;
    if (!map[poNum]) map[poNum]={poNumber:poNum,warehouseName:(data[i][PO_COLS.WAREHOUSE-1]||"").toString().trim(),uploadDate:toDateString_(data[i][PO_COLS.UPLOAD_DATE-1]),expiryDate:(data[i][PO_COLS.EXPIRY_DATE-1]||"").toString().trim(),itemCount:0,totalQty:0,remainingQty:0,status:"OPEN",isDummy:(data[i][PO_COLS.IS_DUMMY-1]===true||data[i][PO_COLS.IS_DUMMY-1]==="TRUE"),_allFulfilled:true};
    const pq=parseInt(data[i][PO_COLS.PO_QTY-1],10)||0;
    const sq=parseInt(data[i][PO_COLS.SHIPPED_QTY-1],10)||0;
    map[poNum].itemCount++; map[poNum].totalQty+=pq; map[poNum].remainingQty+=(pq-sq);
    if (status==="PARTIAL") map[poNum].status="PARTIAL";
    if (status!=="FULFILLED") map[poNum]._allFulfilled=false;
  }
  const result=[];
  let podPoNumbers=null; // built lazily, and only ONCE per call no matter
                          // how many PACKED POs there are — see
                          // getPodPoNumberSet_ for why this replaced a
                          // per-PO isPoPodUploaded_ call here.
  for (const poNum of Object.keys(map)) {
    const entry = map[poNum];
    if (entry._allFulfilled) {
      // Generate Output has closed every line — drop it only once a POD
      // photo actually exists; otherwise keep it visible as PACKED.
      if (!podPoNumbers) podPoNumbers = getPodPoNumberSet_(platform);
      if (podPoNumbers.has(poNum)) continue;
      entry.status = "PACKED";
    }
    delete entry._allFulfilled;
    result.push(entry);
  }
  return result.sort((a,b)=>b.uploadDate.localeCompare(a.uploadDate));
}

/** Script-level cache (shared across every user, not per-session) for
 *  getOpenPosForPlatform_'s result — see that function's PERFORMANCE
 *  comment for why. TTL is a safety net, not the primary freshness
 *  mechanism: invalidateOpenPosCache_ is called explicitly by every
 *  write path that can change a PO's dropdown status, so in normal use
 *  the cache is cleared immediately when something actually changes,
 *  not after the TTL expires. The TTL just guards against any write
 *  path that isn't covered (e.g. a manual sheet edit) leaving stale
 *  data cached indefinitely. */
const OPEN_POS_CACHE_TTL_SECONDS = 600; // 10 minutes
function openPosCache_get_(platform) {
  try {
    const raw = CacheService.getScriptCache().get('openpos_'+platform);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; } // cache errors should never break the actual feature — just fall through to an uncached read
}
function openPosCache_put_(platform, result) {
  try {
    const json = JSON.stringify(result);
    if (json.length < 90000) CacheService.getScriptCache().put('openpos_'+platform, json, OPEN_POS_CACHE_TTL_SECONDS); // CacheService's 100KB/value limit — stay well under it; if it's ever exceeded, simply don't cache rather than error
  } catch(e) { /* caching is a pure optimization — never let it fail the actual request */ }
}
/** Called by every write path that can change what getOpenPosForPlatform_
 *  would return for this platform: a new PO upload, Generate Output
 *  closing a PO out, a shipment delete voiding a PO, or a POD upload. */
function invalidateOpenPosCache_(platform) {
  try { CacheService.getScriptCache().remove('openpos_'+platform); } catch(e) { /* non-fatal */ }
}
function getOpenBlinkitPos() { return getOpenPosForPlatform_('blinkit'); }
function getOpenZeptoPos()   { return getOpenPosForPlatform_('zepto'); }
function getOpenSwiggyPos()  { return getOpenPosForPlatform_('swiggy'); }

function getPoLineItems_impl_(poNumber, platform) {
  const sheet = ensurePoSheet_(platform);
  const data = sheet.getDataRange().getValues();
  return data.slice(1).filter(r=>(r[PO_COLS.PO_NUMBER-1]||"").toString().trim()===poNumber && (r[PO_COLS.STATUS-1]||"").toString().trim().toUpperCase()!=="CANCELLED")
    .map(r=>({itemCode:(r[PO_COLS.ITEM_CODE-1]||"").toString().trim(),upc:(r[PO_COLS.UPC-1]||"").toString().trim(),description:(r[PO_COLS.DESCRIPTION-1]||"").toString().trim(),mrp:parseFloat(r[PO_COLS.MRP-1])||0,landingRate:parseFloat(r[PO_COLS.LANDING_RATE-1])||0,gstPct:parseFloat(r[PO_COLS.GST_PCT-1])||0,poQty:parseInt(r[PO_COLS.PO_QTY-1],10)||0,shippedQty:parseInt(r[PO_COLS.SHIPPED_QTY-1],10)||0,remaining:(parseInt(r[PO_COLS.PO_QTY-1],10)||0)-(parseInt(r[PO_COLS.SHIPPED_QTY-1],10)||0),status:(r[PO_COLS.STATUS-1]||"").toString().trim()}));
}

/** Public wrappers — Apps Script's automatic client-server serialization
 *  has been observed silently corrupting an ARRAY OF OBJECTS return
 *  value (exactly this shape) into unusable garbage, which the client
 *  then receives as a bare null (see redownloadRoInvoice's wrapper
 *  comment for the full story). Explicitly JSON.stringify-ing here and
 *  JSON.parse-ing on the client sidesteps that broken pathway. */
function getPoLineItems(poNumber) {
  return JSON.stringify(getPoLineItems_impl_(poNumber, 'blinkit'));
}
function getZeptoPoLineItems(poNumber) {
  return JSON.stringify(getPoLineItems_impl_(poNumber, 'zepto'));
}
function getSwiggyPoLineItems(poNumber) {
  return JSON.stringify(getPoLineItems_impl_(poNumber, 'swiggy'));
}

/** Fully VOIDS a PO — sets EVERY line item's STATUS to CANCELLED — used
 *  only when deleting the shipment that used it (see
 *  deleteShipmentRecord). Deliberately NOT used for shipment EDITS:
 *  validateAndUpdatePoShipped_'s "monotonic status" rule exists
 *  specifically so editing a shipment down (e.g. one line's quantity
 *  to 0) can never silently reopen a PO — a different shipment, or a
 *  different line of THIS shipment, might still genuinely depend on
 *  it staying closed.
 *
 *  This used to fully REOPEN the PO back to OPEN/qty-0, on the theory
 *  that a deleted shipment should free the PO up for reuse. In
 *  practice that meant a deleted shipment's PO silently reappeared in
 *  the New Shipment dropdown as if nothing had happened, which is
 *  confusing — a deleted shipment should leave no trace of itself
 *  selectable. So a delete now VOIDS the PO instead: CANCELLED lines
 *  are excluded everywhere (getOpenPosForPlatform_, the duplicate-PO
 *  guard, POD eligibility) and SHIPPED_QTY is left as-is for audit
 *  history. The PO Number only becomes usable again via a genuine
 *  fresh upload of that PO (checkPoAlreadyUploaded_ ignores CANCELLED
 *  rows, so re-uploading the same PO Number is allowed and adds a
 *  brand-new set of OPEN rows alongside the voided ones).
 *
 *  PO Numbers are enforced unique across active shipments
 *  (findDuplicateShipmentField_ rejects a second shipment against an
 *  already-used PO), and a PO closes in full — every line, not just
 *  the ones actually shipped — the moment ANY quantity is first
 *  shipped against it (the "closeRemaining" block below). Put
 *  together, at most ONE shipment can ever have used a given PO at a
 *  time. So deleting that one shipment can never leave some OTHER
 *  still-active shipment stranded with lines voided out from under
 *  it — there isn't one. */
function fullyCancelPo_(platform, poNumber) {
  if (!poNumber) return;
  const cfg = poPlatformConfig_(platform);
  if (!cfg) return;
  const sheet = ensurePoSheet_(platform);
  const data = sheet.getDataRange().getValues();
  const rowIdxs = [];
  for (let i = 1; i < data.length; i++) {
    if ((data[i][PO_COLS.PO_NUMBER - 1] || "").toString().trim() === poNumber) rowIdxs.push(i + 1);
  }
  if (!rowIdxs.length) return;
  // PO line items for one PO upload are appended together, so their
  // rows are normally contiguous — one setValues() call for that
  // common case, falling back to per-row writes only if they aren't
  // (defensive; avoids ever touching an unrelated row in between).
  const first = rowIdxs[0], last = rowIdxs[rowIdxs.length - 1];
  if (last - first + 1 === rowIdxs.length) {
    sheet.getRange(first, PO_COLS.STATUS, rowIdxs.length, 1).setValue("CANCELLED");
  } else {
    rowIdxs.forEach(r => sheet.getRange(r, PO_COLS.STATUS).setValue("CANCELLED"));
  }
  // Clear the shipped-quantity color-coding back to white too — mirrors
  // the green/yellow/red coloring validateAndUpdatePoShipped_ applies,
  // so a voided PO doesn't still visually look partially/fully shipped
  // on the rare occasion someone opens the raw sheet.
  const ranges = rowIdxs.map(r => sheet.getRange(r, PO_COLS.SHIPPED_QTY).getA1Notation());
  sheet.getRangeList(ranges).setBackground("#ffffff");
  invalidateOpenPosCache_(platform);
}

function validateAndUpdatePoShipped_(platform, poNumber, boxes, oldBoxes, isEdit, skuRowsOverride) {
  if (!poNumber) return {success:true,errors:[],warnings:[]};
  const cfg = poPlatformConfig_(platform);
  if (!cfg) return {success:true,errors:[],warnings:[]}; // not a PO-driven platform — nothing to validate
  const sheet=ensurePoSheet_(platform);
  const data=sheet.getDataRange().getValues();
  const poMap={};
  for (let i=1;i<data.length;i++) {
    if ((data[i][PO_COLS.PO_NUMBER-1]||"").toString().trim()!==poNumber) continue;
    if ((data[i][PO_COLS.STATUS-1]||"").toString().trim().toUpperCase()==="CANCELLED") continue; // voided rows are never shippable against
    const itemCode=(data[i][PO_COLS.UPC-1]||"").toString().trim(); // UPC column now holds Item Code — see uploadBlinkitPo/uploadZeptoPo
    if (!itemCode) continue;
    poMap[itemCode]={rowIdx:i+1,itemCode:(data[i][PO_COLS.ITEM_CODE-1]||"").toString().trim(),poQty:parseInt(data[i][PO_COLS.PO_QTY-1],10)||0,shippedQty:parseInt(data[i][PO_COLS.SHIPPED_QTY-1],10)||0};
  }
  // Box items carry the SKU name and the barcode (UPC) — neither is the
  // platform's own Item Code the PO is keyed by. Resolve SKU → Item Code
  // via SKU_MASTER's platform-specific item-id column (same field the
  // client matches against).
  // PERFORMANCE: accepts an already-read SKU_MASTER array via
  // skuRowsOverride (submitShipment reads it once and shares it with
  // syncShipmentInventory_ too) instead of re-reading the whole sheet.
  const skuToItemCode={};
  (skuRowsOverride || getSkuData()).forEach(s=>{ if (s.sku && s[cfg.itemIdField]) skuToItemCode[s.sku]=s[cfg.itemIdField].toString().trim(); });
  function sumBoxes_(bxs){const m={};(bxs||[]).forEach(box=>(box.items||[]).forEach(item=>{const ic=skuToItemCode[(item.sku||"").toString().trim()]||"";if(ic)m[ic]=(m[ic]||0)+(parseInt(item.qty,10)||0);}));return m;}
  const newQtyMap=sumBoxes_(boxes);
  const oldQtyMap=isEdit?sumBoxes_(oldBoxes):{};
  const errors=[],warnings=[];
  for (const itemCode of Object.keys(newQtyMap)) {
    const newQty=newQtyMap[itemCode]||0,oldQty=oldQtyMap[itemCode]||0,delta=newQty-oldQty;
    if (!poMap[itemCode]){warnings.push("Item "+itemCode+" is not in PO "+poNumber+" — shipping anyway.");continue;}
    if (poMap[itemCode].shippedQty+delta>poMap[itemCode].poQty)
      errors.push("Item "+itemCode+": trying to ship "+newQty+" but only "+(poMap[itemCode].poQty-poMap[itemCode].shippedQty)+" remain in PO "+poNumber+".");
  }
  if (errors.length) return {success:false,errors,warnings};
  const updates={};
  for (const itemCode of Object.keys(newQtyMap)){const d=(newQtyMap[itemCode]||0)-(oldQtyMap[itemCode]||0);if(!poMap[itemCode])continue;updates[poMap[itemCode].rowIdx]=(poMap[itemCode].shippedQty+d);}
  for (const itemCode of Object.keys(oldQtyMap)){if(newQtyMap[itemCode]!==undefined||!poMap[itemCode])continue;updates[poMap[itemCode].rowIdx]=Math.max(0,poMap[itemCode].shippedQty-(oldQtyMap[itemCode]||0));}

  // PERFORMANCE: the old version did up to 3 separate Sheets API calls
  // (SHIPPED_QTY setValue, setBackground, STATUS setValue) PER PO LINE
  // ITEM — a 10-item PO meant ~30 round-trips here alone, which is what
  // made "Generate Outputs" feel slow. Everything below is now collapsed
  // into ONE setValues() call for the SHIPPED_QTY+STATUS block, plus at
  // most 3 setBackground() calls total (one per distinct color used),
  // regardless of how many line items are touched.
  const updateRowIdxs = Object.keys(updates).map(s => parseInt(s, 10));
  const hasUpdates = updateRowIdxs.length > 0;
  // A fresh submission (isEdit=false) also force-closes every OTHER line
  // of this PO to FULFILLED (see comment further below) — fold that into
  // the same in-memory pass so it's part of the single write too.
  const closeRemaining = !isEdit && hasUpdates;

  if (hasUpdates || closeRemaining) {
    const numDataRows = data.length - 1; // excludes header
    // Start from the existing SHIPPED_QTY/STATUS values so untouched rows
    // are written back unchanged (setValues overwrites the whole block).
    const valuesBlock = data.slice(1).map(r => [r[PO_COLS.SHIPPED_QTY-1], r[PO_COLS.STATUS-1]]);
    const bgByColor = {}; // color -> array of A1 row ranges to paint

    for (const rowIdx of updateRowIdxs) {
      const newShipped = updates[rowIdx];
      valuesBlock[rowIdx-2][0] = newShipped;
      // STATUS IS MONOTONIC: once a line has been closed to FULFILLED
      // (by the original submission), later edits/deletes must NEVER
      // flip it back to OPEN — otherwise editing a shipment down to 0 on
      // one line (or deleting it) would silently reopen the whole PO in
      // the "New Shipment" dropdown, since getOpenPosForPlatform_ shows
      // a PO if ANY single line is OPEN. A PO should only ever become
      // selectable again via a brand-new PO upload, never by editing an
      // existing shipment against it.
      const alreadyFulfilled = (data[rowIdx-1][PO_COLS.STATUS-1]||"").toString().trim().toUpperCase() === "FULFILLED";
      valuesBlock[rowIdx-2][1] = (newShipped>0 || alreadyFulfilled) ? "FULFILLED" : "OPEN";
      const itemCodeForRow=(data[rowIdx-1][PO_COLS.UPC-1]||"").toString().trim();
      const entryForRow=poMap[itemCodeForRow];
      const poQty=entryForRow?entryForRow.poQty:0;
      let bg="#ffffff";
      if (poQty>0){if(newShipped===0)bg="#FFC7CE";else if(newShipped<poQty)bg="#FFEB9C";else bg="#C6EFCE";}
      (bgByColor[bg] = bgByColor[bg] || []).push(rowIdx);
    }

    // A fresh submission (isEdit=false) is a one-shot use of the PO: once
    // ANY quantity has been shipped against it, the WHOLE PO closes
    // immediately and drops out of the open-PO dropdown for everyone —
    // even if some line items still have unshipped balance. Any further
    // additions happen by editing that shipment from the Shipments tab,
    // not by re-selecting the PO fresh. This full-PO close only runs on
    // the original submission (isEdit=false) — but per the monotonic
    // rule above, editing or deleting the shipment afterward can never
    // undo it either, since a FULFILLED line is never written back to
    // OPEN. A PO stays closed forever once used; only a brand-new PO
    // upload creates fresh OPEN rows.
    if (closeRemaining) {
      for (let i=1;i<data.length;i++) {
        if ((data[i][PO_COLS.PO_NUMBER-1]||"").toString().trim()!==poNumber) continue;
        if ((data[i][PO_COLS.STATUS-1]||"").toString().trim().toUpperCase()==="CANCELLED") continue; // leave voided rows alone
        const rowIdx=i+1;
        if (updates[rowIdx]!==undefined) continue; // already set above
        valuesBlock[rowIdx-2][1] = "FULFILLED";
      }
    }

    sheet.getRange(2, PO_COLS.SHIPPED_QTY, numDataRows, 2).setValues(valuesBlock);
    for (const color of Object.keys(bgByColor)) {
      const ranges = bgByColor[color].map(rowIdx => sheet.getRange(rowIdx, PO_COLS.SHIPPED_QTY).getA1Notation());
      sheet.getRangeList(ranges).setBackground(color);
    }
    invalidateOpenPosCache_(platform);
  }
  return {success:true,errors:[],warnings};
}

/** Reports, for every PO that's had at least one shipment against it,
 *  whether every one of its line items had its FULL ordered quantity
 *  matched (allMatched:true) or some items were left with unshipped
 *  balance when the PO was closed (allMatched:false). Purely a display
 *  concern now — see the "one-shot use" comment in
 *  validateAndUpdatePoShipped_ for why a PO can close without every
 *  item's quantity being fully matched. Used to color the Balance
 *  button in the Shipments tab (light green = fully matched, light red
 *  = left with unshipped balance) without needing a per-item status
 *  concept in the sheet itself. */
function getPoFulfillmentMap_impl_(platform) {
  const sheet=ensurePoSheet_(platform);
  const data=sheet.getDataRange().getValues();
  const map={};
  for (let i=1;i<data.length;i++) {
    const poNum=(data[i][PO_COLS.PO_NUMBER-1]||"").toString().trim();
    if (!poNum) continue;
    const status=(data[i][PO_COLS.STATUS-1]||"").toString().trim().toUpperCase();
    if (status==="CANCELLED") continue; // voided rows sit out of these stats entirely
    const pq=parseInt(data[i][PO_COLS.PO_QTY-1],10)||0;
    const sq=parseInt(data[i][PO_COLS.SHIPPED_QTY-1],10)||0;
    // "fulfilled" is stricter than allMatched: true only if EVERY line
    // of this PO has its STATUS column at FULFILLED (the monotonic,
    // never-reopens status set by validateAndUpdatePoShipped_) — used to
    // gate the Upload POD button, which should only appear once the PO
    // is truly closed out, not just "fully matched on quantity" (a PO
    // can be allMatched but still technically have an OPEN line if it
    // was never touched at all).
    if (!map[poNum]) map[poNum]={anyTouched:false,allMatched:true,fulfilled:true};
    if (sq>0) map[poNum].anyTouched=true;
    if (sq<pq) map[poNum].allMatched=false;
    if (status!=="FULFILLED") map[poNum].fulfilled=false;
  }
  return map;
}

/** Public wrappers — see redownloadRoInvoice's wrapper comment for why
 *  this explicitly JSON.stringify's instead of returning the object
 *  directly. */
function getPoFulfillmentMap() {
  return JSON.stringify(getPoFulfillmentMap_impl_('blinkit'));
}
function getZeptoPoFulfillmentMap() {
  return JSON.stringify(getPoFulfillmentMap_impl_('zepto'));
}
function getSwiggyPoFulfillmentMap() {
  return JSON.stringify(getPoFulfillmentMap_impl_('swiggy'));
}

// ════════════════════════════════════════════════════════════════
//  PO POD (PROOF OF DELIVERY)
//  Sheet: PO_POD — one row per platform+PO Number. The photo is stored
//  as a compressed base64 data-URL directly in the cell (client-side
//  canvas compression keeps it well under Sheets' ~50,000-char cell
//  limit) instead of via DriveApp — same "no DriveApp needed" approach
//  already used for PDF parsing above, avoids Drive sharing/permission
//  complexity entirely for a single small photo per PO.
// ════════════════════════════════════════════════════════════════
const SHEET_PO_POD = "PO_POD";
const POD_COLS = { PLATFORM:1, PO_NUMBER:2, IMAGE_DATA:3, MIME_TYPE:4, UPLOADED_BY:5, UPLOAD_DATE:6 };

function ensurePodSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_PO_POD);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_PO_POD);
    sheet.appendRow(["PLATFORM","PO_NUMBER","IMAGE_DATA","MIME_TYPE","UPLOADED_BY","UPLOAD_DATE"]);
  }
  return sheet;
}

function findPodRow_(sheet, platform, poNumber) {
  const data = sheet.getDataRange().getValues();
  const plat = (platform||"").toString().toLowerCase().trim();
  for (let i=1;i<data.length;i++) {
    if ((data[i][POD_COLS.PLATFORM-1]||"").toString().toLowerCase().trim()===plat &&
        (data[i][POD_COLS.PO_NUMBER-1]||"").toString().trim()===poNumber) return i+1; // 1-based sheet row
  }
  return -1;
}

/** Same purpose as isPoPodUploaded_ but batched: reads the PO_POD sheet
 *  ONCE and returns every PO Number (for this platform) that has a POD
 *  on file, as a Set. getOpenPosForPlatform_ used to call
 *  isPoPodUploaded_ — a full PO_POD sheet scan — once per PACKED PO,
 *  which turned a dropdown load into N spreadsheet reads and was slow
 *  enough (with more than a handful of packed POs sitting around) to
 *  make the client's in-flight request outlive a newer one, so a
 *  slower/stale response could land after a faster one and flash the
 *  dropdown to the wrong (or empty) list. This does the same job in a
 *  single read regardless of how many POs need checking. */
function getPodPoNumberSet_(platform) {
  const podSheet = ensurePodSheet_();
  const data = podSheet.getDataRange().getValues();
  const plat = (platform||"").toString().toLowerCase().trim();
  const set = new Set();
  for (let i=1;i<data.length;i++) {
    if ((data[i][POD_COLS.PLATFORM-1]||"").toString().toLowerCase().trim()===plat) {
      set.add((data[i][POD_COLS.PO_NUMBER-1]||"").toString().trim());
    }
  }
  return set;
}

/** True if a POD photo has already been saved for this platform+PO —
 *  the final gate between PACKED (Generate Output done, still shown in
 *  the New Shipment dropdown) and truly FULFILLED (POD on file, removed
 *  from the dropdown). Used by checkPoAlreadyUploaded_ for a single
 *  PO lookup — getOpenPosForPlatform_ uses the batched
 *  getPodPoNumberSet_ instead since it needs to check many POs at once.
 *  Safe to call before the PO_POD sheet exists since ensurePodSheet_
 *  creates it on demand. */
function isPoPodUploaded_(platform, poNumber) {
  return findPodRow_(ensurePodSheet_(), platform, poNumber) > 0;
}

/** True only if every line of this PO (across the platform's PO sheet)
 *  is at STATUS=FULFILLED — mirrors the "fulfilled" flag computed in
 *  getPoFulfillmentMap_impl_, re-derived here (rather than trusting the
 *  client) so a stale page or a tampered request can't attach a POD to
 *  a PO that isn't actually closed yet. */
function isPoFullyFulfilled_(platform, poNumber) {
  const cfg = poPlatformConfig_(platform);
  if (!cfg) return false;
  const sheet = ensurePoSheet_(platform);
  const data = sheet.getDataRange().getValues();
  let found = false, allFulfilled = true;
  for (let i=1;i<data.length;i++) {
    if ((data[i][PO_COLS.PO_NUMBER-1]||"").toString().trim()!==poNumber) continue;
    const rowStatus = (data[i][PO_COLS.STATUS-1]||"").toString().trim().toUpperCase();
    if (rowStatus==="CANCELLED") continue; // voided rows don't count toward (or block) fulfillment
    found = true;
    if (rowStatus!=="FULFILLED") allFulfilled = false;
  }
  return found && allFulfilled;
}

/** Saves (or replaces, if one already exists) the POD photo for a PO.
 *  Only allowed once the PO is fully Fulfilled. imageDataUrl is the
 *  full "data:image/jpeg;base64,...." string produced client-side after
 *  canvas compression (see compressImageFile_ in the frontend). */
function uploadPod(params) {
  try {
    const platform = (params.platform||"").toString().toLowerCase().trim();
    const poNumber = (params.poNumber||"").toString().trim();
    if (!poNumber) return {success:false,message:"No PO Number given."};
    if (!poPlatformConfig_(platform)) return {success:false,message:"POD is only available for Blinkit/Zepto/Swiggy POs."};
    if (!isPoFullyFulfilled_(platform, poNumber)) return {success:false,message:"POD can only be uploaded once PO "+poNumber+" is fully Fulfilled."};
    const imageDataUrl = (params.imageDataUrl||"").toString();
    const mimeMatch = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
    if (!mimeMatch) return {success:false,message:"No valid image received."};
    if (imageDataUrl.length > 48000) return {success:false,message:"Image too large even after compression — please retake with less detail."};
    const podSheet = ensurePodSheet_();
    const rowValues = [platform, poNumber, imageDataUrl, mimeMatch[1], (params.uploadedBy||"").toString().trim(), toDateString_(new Date())];
    const rowIdx = findPodRow_(podSheet, platform, poNumber);
    if (rowIdx > 0) podSheet.getRange(rowIdx,1,1,rowValues.length).setValues([rowValues]);
    else podSheet.appendRow(rowValues);
    invalidateOpenPosCache_(platform);
    return {success:true};
  } catch(err) { return {success:false,message:err.message}; }
}

function getPod_impl_(platform, poNumber) {
  const podSheet = ensurePodSheet_();
  const rowIdx = findPodRow_(podSheet, platform, (poNumber||"").toString().trim());
  if (rowIdx<0) return {exists:false};
  const row = podSheet.getRange(rowIdx,1,1,6).getValues()[0];
  return {
    exists:true,
    imageDataUrl: row[POD_COLS.IMAGE_DATA-1],
    mimeType: row[POD_COLS.MIME_TYPE-1],
    uploadedBy: row[POD_COLS.UPLOADED_BY-1],
    uploadDate: toDateString_(row[POD_COLS.UPLOAD_DATE-1])
  };
}
/** Public wrapper — JSON.stringify's for the same reason as
 *  getPoLineItems etc. (see that comment above). */
function getPod(platform, poNumber) {
  return JSON.stringify(getPod_impl_(platform, poNumber));
}

/** Returns { poNumber: true, ... } for every PO on this platform that
 *  already has a POD uploaded — one round-trip lets the Shipments list
 *  render "View POD" vs "Upload POD" per row without a per-row RPC. */
function getPodStatusMap_impl_(platform) {
  const podSheet = ensurePodSheet_();
  const data = podSheet.getDataRange().getValues();
  const plat = (platform||"").toString().toLowerCase().trim();
  const map = {};
  for (let i=1;i<data.length;i++) {
    if ((data[i][POD_COLS.PLATFORM-1]||"").toString().toLowerCase().trim()!==plat) continue;
    const poNum = (data[i][POD_COLS.PO_NUMBER-1]||"").toString().trim();
    if (poNum) map[poNum]=true;
  }
  return map;
}
function getPodStatusMap(platform) {
  return JSON.stringify(getPodStatusMap_impl_(platform));
}

// ── Median helper — more robust to one-off outlier box sizes than a
// plain average, while still reflecting the "typical" pack size. Shared
// by the statistical allocator and the AI-assisted one below.
function median_(arr){
  const s=arr.slice().sort((a,b)=>a-b);
  const mid=Math.floor(s.length/2);
  return s.length%2 ? s[mid] : Math.round((s[mid-1]+s[mid])/2);
}

/** Learns packing patterns for a PO from EVERY past shipment on the
 *  same PO-driven platform (blinkit/zepto/swiggy) — not just the
 *  single closest match. This IS the "memory" both suggestion modes
 *  below reason over: it's re-mined fresh from the real shipment log
 *  on every call rather than kept in some separate store, so it's
 *  always exactly as current as the log itself.
 *
 *  1. Every historical box is reduced to just the items that are also in
 *     the current PO (items not in the PO are dropped from that box —
 *     the box itself is kept if anything remains).
 *  2. Reduced boxes are grouped into "patterns" by which Item Codes they
 *     contain together, with a typical (median) quantity per item in
 *     that pattern learned across every time it occurred historically.
 */
// Warehouses whose past shipments must NOT be learned from — they pack
// to their own different box setup, so mixing their history into the
// pattern pool would teach the AI/statistical suggester box shapes that
// don't apply anywhere else and drag down suggestion quality generally.
// Matched case-insensitively, trimmed, against the shipment's CITY field
// (which is auto-filled from the PO's warehouse name — see onPoSelected_
// in ShipmentManagerIndex.html) — keep these strings in sync with
// whatever the warehouse name actually looks like there if it ever
// changes. Shipments TO these warehouses can still be created and can
// still ask for a suggestion — they just won't have much (or any)
// packing history to draw on, same as any other warehouse with no
// history yet.
const BOX_SUGGESTION_EXCLUDED_WAREHOUSES_ = ['faridabad', 'jaipur j3', 'noida n1'];
function isExcludedWarehouseForBoxLearning_(cityValue) {
  return BOX_SUGGESTION_EXCLUDED_WAREHOUSES_.indexOf((cityValue || '').toString().trim().toLowerCase()) !== -1;
}

function mineBoxPatterns_(poNumber, platform) {
  platform = (platform || 'blinkit').toString().trim().toLowerCase();
  if (!poPlatformConfig_(platform)) return {success:false,reason:"error",message:"Unknown platform: "+platform};

  const poSheet=ensurePoSheet_(platform);
  const poData=poSheet.getDataRange().getValues();
  const poItems={};
  for (let i=1;i<poData.length;i++) {
    if ((poData[i][PO_COLS.PO_NUMBER-1]||"").toString().trim()!==poNumber) continue;
    const itemCode=(poData[i][PO_COLS.UPC-1]||"").toString().trim(); // UPC column holds Item Code — see uploadBlinkitPo
    if (!itemCode) continue;
    const pq=parseInt(poData[i][PO_COLS.PO_QTY-1],10)||0;
    const sq=parseInt(poData[i][PO_COLS.SHIPPED_QTY-1],10)||0;
    poItems[itemCode]={poQty:pq,shippedQty:sq,remaining:pq-sq};
  }
  if (!Object.keys(poItems).length) return {success:false,reason:"no_po_items",message:"No line items found for PO "+poNumber};

  // Historical shipment box items only carry SKU name + barcode (never
  // Item Code), so resolve Item Code via SKU_MASTER's per-platform
  // *_ITEM_ID column — the same lookup used for live PO matching
  // elsewhere (roFieldsForPlatform_). Also keep a reverse lookup for
  // rebuilding output items (sku name, barcode, weight).
  const roFields = roFieldsForPlatform_(platform);
  const skuRows = getSkuData();
  const skuToItemCode={}, itemCodeToSkuInfo={};
  skuRows.forEach(s=>{
    const ic=(s[roFields.itemIdField]||"").toString().trim();
    if (!s.sku || !ic) return;
    skuToItemCode[s.sku]=ic;
    if (!itemCodeToSkuInfo[ic]) itemCodeToSkuInfo[ic]={sku:s.sku,upc:(s[roFields.upcField]||"").toString().trim(),weight:s.weight||0};
  });

  // ── Step 1+2: scan every past shipment's boxes on this platform,
  // reduce each to PO-relevant items only, and tally patterns by which
  // Item Codes co-occur.
  const shSheet=ensureShipmentsSheet_();
  const shData=shSheet.getDataRange().getValues();
  const patternOccurrences={}; // key: sorted itemCodes joined by '|' → array of {itemCode: qty} maps
  const soloQtyByItem={};      // itemCode → array of quantities seen when it was the ONLY item in a box
  const anyQtyByItem={};       // itemCode → array of quantities seen in ANY box (fallback if never solo)
  let shipmentsScanned=0, mostRecentTs=0;
  for (let i=1;i<shData.length;i++) {
    const r=shData[i];
    if (r[SHIP_COLS.DELETED-1]===true||r[SHIP_COLS.DELETED-1]==="TRUE") continue;
    if ((r[SHIP_COLS.PLATFORM-1]||"").toString().trim().toLowerCase()!==platform) continue;
    if (isExcludedWarehouseForBoxLearning_(r[SHIP_COLS.CITY-1])) continue; // different box setup — don't pollute the learned patterns
    let boxes;try{boxes=JSON.parse(r[SHIP_COLS.BOXES_JSON-1]||"[]");}catch(e){continue;}
    if (!boxes.length) continue;
    let touchedThisShipment=false;
    boxes.forEach(box=>{
      const reduced={}; // itemCode → qty, PO-relevant items only
      (box.items||[]).forEach(item=>{
        const ic=skuToItemCode[(item.sku||"").toString().trim()];
        if (!ic || !poItems[ic]) return; // not in current PO — dropped, box itself is kept
        const q=parseInt(item.qty,10)||0;
        if (q>0) reduced[ic]=(reduced[ic]||0)+q;
      });
      const codes=Object.keys(reduced);
      if (!codes.length) return; // nothing in this box relevant to the current PO
      touchedThisShipment=true;
      codes.forEach(ic=>{
        (anyQtyByItem[ic]=anyQtyByItem[ic]||[]).push(reduced[ic]);
        if (codes.length===1) (soloQtyByItem[ic]=soloQtyByItem[ic]||[]).push(reduced[ic]);
      });
      const key=codes.slice().sort().join('|');
      (patternOccurrences[key]=patternOccurrences[key]||[]).push(reduced);
    });
    if (touchedThisShipment) {
      shipmentsScanned++;
      const ts=r[SHIP_COLS.TIMESTAMP-1] instanceof Date?r[SHIP_COLS.TIMESTAMP-1].getTime():new Date(r[SHIP_COLS.TIMESTAMP-1]||0).getTime();
      if (ts>mostRecentTs) mostRecentTs=ts;
    }
  }
  if (!shipmentsScanned) return {success:false,reason:"no_history",message:"No past "+platform+" shipments found with matching SKUs."};

  // ── Step 2 (cont.): collapse each pattern's occurrences into one
  // representative {itemCode: typicalQty} using the median per item,
  // and rank patterns by how often they occurred (most common first),
  // preferring richer multi-item patterns as a tiebreaker.
  const patterns=Object.keys(patternOccurrences).map(key=>{
    const occ=patternOccurrences[key];
    const itemCodes=key.split('|');
    const typical={};
    itemCodes.forEach(ic=>{ typical[ic]=median_(occ.map(o=>o[ic]||0).filter(q=>q>0)); });
    return { itemCodes, typical, frequency:occ.length };
  }).sort((a,b)=> b.frequency-a.frequency || b.itemCodes.length-a.itemCodes.length);

  return { success:true, platform, poItems, patterns, soloQtyByItem, anyQtyByItem, itemCodeToSkuInfo, shipmentsScanned, mostRecentTs };
}

/** Greedy statistical allocator — applies the most-common historical
 *  patterns first, repeatedly, until no pattern can be fully filled
 *  from the PO's remaining balance any more; leftover balance for an
 *  item with no more usable multi-item pattern falls back to that
 *  item's own typical solo box size; anything left with zero
 *  historical packing data anywhere goes into "unassigned" for manual
 *  entry. This is also the AI-assisted suggestion's fallback whenever
 *  Gemini isn't configured, errors, or returns something that doesn't
 *  reconcile with the PO balance. */
function buildStatisticalBoxes_(mined) {
  const { poItems, patterns, soloQtyByItem, anyQtyByItem, itemCodeToSkuInfo } = mined;
  const remaining={}; Object.keys(poItems).forEach(ic=>remaining[ic]=Math.max(0,poItems[ic].remaining));
  const outputBoxes=[];
  const MAX_BOXES=2000; // safety cap against any pathological data
  for (const p of patterns) {
    while (p.itemCodes.every(ic=>remaining[ic]>0) && outputBoxes.length<MAX_BOXES) {
      const items=p.itemCodes.map(ic=>{
        const qty=Math.min(p.typical[ic], remaining[ic]);
        remaining[ic]-=qty;
        const info=itemCodeToSkuInfo[ic]||{sku:ic,upc:'',weight:0};
        return { sku:info.sku, upc:info.upc, qty, weightPerUnit:info.weight, inPo:true };
      }).filter(it=>it.qty>0);
      if (items.length) outputBoxes.push({items}); else break;
    }
  }
  // Fallback: leftover balance for items whose companions in every known
  // pattern are already exhausted — box them solo, at their own typical
  // solo size (or typical size in any box, if never seen solo).
  for (const ic of Object.keys(remaining)) {
    const sizes = (soloQtyByItem[ic] && soloQtyByItem[ic].length) ? soloQtyByItem[ic] : anyQtyByItem[ic];
    if (!sizes || !sizes.length) continue; // no historical data at all — leave for "unassigned"
    const soloSize=Math.max(1, median_(sizes));
    const info=itemCodeToSkuInfo[ic]||{sku:ic,upc:'',weight:0};
    let guard=0;
    while (remaining[ic]>0 && guard++<1000 && outputBoxes.length<MAX_BOXES) {
      const qty=Math.min(soloSize, remaining[ic]);
      remaining[ic]-=qty;
      outputBoxes.push({items:[{sku:info.sku,upc:info.upc,qty,weightPerUnit:info.weight,inPo:true}]});
    }
  }

  outputBoxes.forEach((b,idx)=>{b.boxNumber=idx+1;});
  const unassigned=[];
  let itemsWithData=0;
  for (const ic of Object.keys(poItems)) {
    if (anyQtyByItem[ic] && anyQtyByItem[ic].length) itemsWithData++;
    if ((remaining[ic]||0)>0) unassigned.push({itemCode:ic, sku:(itemCodeToSkuInfo[ic]||{}).sku||ic, qty:remaining[ic]});
  }
  const overlapPct=Math.round((itemsWithData/Object.keys(poItems).length)*100);
  return { boxes:outputBoxes, unassigned, totalBoxes:outputBoxes.length, overlapPct };
}

/** Public: pure-statistical box suggestion, no AI involved. Kept as its
 *  own entry point for anything that wants the deterministic version
 *  specifically; the New Shipment form itself calls
 *  getAiSuggestedBoxLayout below, which uses this as its fallback.
 *  platform defaults to 'blinkit' for backward compatibility with any
 *  existing caller that only ever passed poNumber. */
function getSuggestedBoxLayout(poNumber, platform) {
  try {
    const mined = mineBoxPatterns_(poNumber, platform);
    if (!mined.success) return mined;
    const built = buildStatisticalBoxes_(mined);
    return {
      success:true,
      boxes:built.boxes,
      reference:{ platform:mined.platform, shipmentsUsed:mined.shipmentsScanned, mostRecentDate: mined.mostRecentTs?toDateString_(new Date(mined.mostRecentTs)):'', overlapPct:built.overlapPct },
      unassigned:built.unassigned,
      totalBoxes:built.totalBoxes,
      aiUsed:false
    };
  } catch(err) { return {success:false,reason:"error",message:err.message}; }
}

// ════════════════════════════════════════════════════════════════
//  AI-ASSISTED BOX SUGGESTION — reuses the Gemini setup below (same
//  GEMINI_API_KEY script property, same model/retry constants as the
//  Help chat's aiAssistantAsk). "Memory" here is deliberately NOT a
//  separate store: every call re-mines the real packing patterns
//  straight out of the shipment log via mineBoxPatterns_ above, so
//  suggestions are always as current as the log itself with nothing
//  extra to keep in sync. Gemini's job on top of that mined data is
//  judgment, not arithmetic: which historical patterns to combine and
//  how to size the leftovers. Every quantity it proposes is then
//  reconciled in code against the PO's real remaining balance (see
//  reconcileAiBoxes_), so a model mistake can only ever get silently
//  corrected — or the whole suggestion falls back to the plain
//  statistical version above — never shown as a wrong number.
// ════════════════════════════════════════════════════════════════

const BOX_SUGGESTION_MAX_PATTERNS_ = 60; // caps prompt size regardless of shipment history depth
const BOX_SUGGESTION_PATCH_FALLBACK_RATIO_ = 0.6; // if Gemini's numbers needed correcting on more than this fraction of items, its allocation wasn't trustworthy enough to present as "AI" — use the plain statistical version instead

function boxSuggestionSchema_() {
  return {
    type: "OBJECT",
    properties: {
      note: { type: "STRING", description: "One short plain sentence explaining the packing logic used, for display to a warehouse employee. No markdown." },
      boxes: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            items: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  itemCode: { type: "STRING" },
                  qty: { type: "INTEGER" }
                },
                required: ["itemCode", "qty"]
              }
            }
          },
          required: ["items"]
        }
      }
    },
    required: ["boxes"]
  };
}

/** One-shot structured-JSON Gemini call — separate from aiAssistantAsk's
 *  conversational function-calling loop since this always wants exactly
 *  one JSON object back, no tool use, no multi-turn history. Same
 *  retry-once-on-429 behavior as aiAssistantAsk. */
function callGeminiStructured_(systemPrompt, userPayload, schema) {
  const apiKey = geminiApiKey_();
  if (!apiKey) return { ok:false, reason:"not_configured" };
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_API_MODEL_ + ":generateContent";
  const body = {
    contents: [{ role:"user", parts:[{ text: JSON.stringify(userPayload) }] }],
    systemInstruction: { parts:[{ text: systemPrompt }] },
    generationConfig: { responseMimeType: "application/json", responseSchema: schema }
  };
  const opts = { method:"post", contentType:"application/json", headers:{ "x-goog-api-key": apiKey }, muteHttpExceptions:true, payload: JSON.stringify(body) };
  let resp;
  try { resp = UrlFetchApp.fetch(url, opts); } catch (e) { return { ok:false, reason:"network_error", message:e.message }; }
  if (resp.getResponseCode() === 429) {
    Utilities.sleep(AI_ASSISTANT_RETRY_DELAY_MS_);
    try { resp = UrlFetchApp.fetch(url, opts); } catch (e) { return { ok:false, reason:"network_error", message:e.message }; }
  }
  if (resp.getResponseCode() !== 200) return { ok:false, reason:"api_error", message: resp.getContentText() };
  try {
    const parsedBody = JSON.parse(resp.getContentText());
    const part = parsedBody.candidates && parsedBody.candidates[0] && parsedBody.candidates[0].content && parsedBody.candidates[0].content.parts && parsedBody.candidates[0].content.parts[0];
    if (!part || typeof part.text !== "string") return { ok:false, reason:"empty_response" };
    return { ok:true, data: JSON.parse(part.text) };
  } catch (e) { return { ok:false, reason:"parse_error", message:e.message }; }
}

/** Reconciles Gemini's proposed box list against the REAL remaining PO
 *  balance per item, item by item:
 *   - unknown item codes / non-positive quantities are dropped
 *   - any item Gemini under-allocated gets the shortfall appended as
 *     its own trailing box
 *   - any item Gemini over-allocated gets trimmed off its last box
 *     (removing that item line, or the box itself, if it hits zero)
 *  This is what makes the AI suggestion safe to trust: whatever comes
 *  out always sums EXACTLY to the PO's remaining balance, no matter
 *  what Gemini actually returned. Returns null if the response needed
 *  correcting on too large a share of items to be worth presenting as
 *  an AI suggestion at all (BOX_SUGGESTION_PATCH_FALLBACK_RATIO_). */
function reconcileAiBoxes_(aiBoxes, allowedItemCodes, itemCodeToSkuInfo, poItems) {
  const allowed = {}; allowedItemCodes.forEach(ic=>allowed[ic]=true);
  // Gemini sometimes lists the same itemCode more than once within a
  // SINGLE box's items array (e.g. mashing two patterns together) —
  // merge those into one line by summing quantities BEFORE anything
  // else runs, so a box never shows the same SKU twice with a split or
  // duplicated quantity. Same itemCode appearing in DIFFERENT boxes is
  // left alone — splitting a SKU across multiple boxes is normal.
  let boxes = (aiBoxes||[]).map(b=>{
    const qtyByItem = {};
    (b.items||[]).forEach(it => {
      if (!it) return;
      const ic=(it.itemCode||"").toString().trim();
      if (!allowed[ic] || !Number.isFinite(it.qty) || Math.floor(it.qty)<=0) return;
      qtyByItem[ic]=(qtyByItem[ic]||0)+Math.floor(it.qty);
    });
    return {
      items: Object.keys(qtyByItem).map(ic => {
        const info=itemCodeToSkuInfo[ic]||{sku:ic,upc:'',weight:0};
        return { sku:info.sku, upc:info.upc, qty:qtyByItem[ic], weightPerUnit:info.weight, inPo:true, _ic:ic };
      })
    };
  }).filter(b=>b.items.length);

  const assigned={};
  boxes.forEach(b=>b.items.forEach(it=>{ assigned[it._ic]=(assigned[it._ic]||0)+it.qty; }));

  let patchedItems=0;
  allowedItemCodes.forEach(ic=>{
    const required=Math.max(0,poItems[ic].remaining);
    const have=assigned[ic]||0;
    const delta=required-have;
    if (delta===0) return;
    patchedItems++;
    if (delta>0) {
      const info=itemCodeToSkuInfo[ic]||{sku:ic,upc:'',weight:0};
      boxes.push({ items:[{ sku:info.sku, upc:info.upc, qty:delta, weightPerUnit:info.weight, inPo:true, _ic:ic }] });
    } else {
      let toRemove=-delta;
      for (let bi=boxes.length-1; bi>=0 && toRemove>0; bi--) {
        const b=boxes[bi];
        for (let ii=b.items.length-1; ii>=0 && toRemove>0; ii--) {
          if (b.items[ii]._ic!==ic) continue;
          const cut=Math.min(b.items[ii].qty, toRemove);
          b.items[ii].qty-=cut; toRemove-=cut;
          if (b.items[ii].qty<=0) b.items.splice(ii,1);
        }
      }
      boxes = boxes.filter(b=>b.items.length);
    }
  });

  if (allowedItemCodes.length && (patchedItems/allowedItemCodes.length) > BOX_SUGGESTION_PATCH_FALLBACK_RATIO_) return null;

  boxes.forEach(b=>b.items.forEach(it=>{ delete it._ic; }));
  boxes.forEach((b,idx)=>{ b.boxNumber=idx+1; });
  return { boxes, patchedItems };
}

/** Public: AI-assisted "Suggest Boxes from History", used by the New
 *  Shipment form for Blinkit/Zepto/Swiggy. Falls back to the plain
 *  statistical version (buildStatisticalBoxes_) whenever Gemini isn't
 *  configured, errors, or returns something that doesn't reconcile
 *  well against the real PO balance — so this always returns SOME
 *  usable suggestion as long as there's packing history to learn from,
 *  AI or not. See the section header above for how "memory" works
 *  here (re-mined live from the shipment log, not a separate store). */
function getAiSuggestedBoxLayout(poNumber, platform) {
  try {
    const mined = mineBoxPatterns_(poNumber, platform);
    if (!mined.success) return mined;

    const fallback = buildStatisticalBoxes_(mined);
    const fallbackResult = {
      success:true,
      boxes:fallback.boxes,
      reference:{ platform:mined.platform, shipmentsUsed:mined.shipmentsScanned, mostRecentDate: mined.mostRecentTs?toDateString_(new Date(mined.mostRecentTs)):'', overlapPct:fallback.overlapPct },
      unassigned:fallback.unassigned,
      totalBoxes:fallback.totalBoxes,
      aiUsed:false
    };

    if (!geminiApiKey_()) return fallbackResult;

    // Only items with SOME packing history are worth asking Gemini
    // about — items with zero history go straight to "unassigned",
    // same as the statistical version, since neither of us has a
    // pattern to learn from for those.
    const allowedItemCodes = Object.keys(mined.poItems).filter(ic => (mined.anyQtyByItem[ic]||[]).length>0);
    if (!allowedItemCodes.length) return fallbackResult;

    const itemsToAllocate = allowedItemCodes.map(ic => ({
      itemCode: ic,
      sku: (mined.itemCodeToSkuInfo[ic]||{}).sku || ic,
      qtyToAllocate: Math.max(0, mined.poItems[ic].remaining)
    })).filter(it => it.qtyToAllocate>0);
    if (!itemsToAllocate.length) return fallbackResult;

    const topPatterns = mined.patterns.slice(0, BOX_SUGGESTION_MAX_PATTERNS_).map(p => ({
      itemCodes: p.itemCodes,
      skus: p.itemCodes.map(ic => (mined.itemCodeToSkuInfo[ic]||{}).sku || ic),
      typicalQtyPerItem: p.typical,
      seenNTimes: p.frequency
    }));
    const soloQtyHint = {};
    allowedItemCodes.forEach(ic => {
      const sizes = (mined.soloQtyByItem[ic]&&mined.soloQtyByItem[ic].length) ? mined.soloQtyByItem[ic] : mined.anyQtyByItem[ic];
      if (sizes && sizes.length) soloQtyHint[ic] = median_(sizes);
    });

    const systemPrompt = "You are a warehouse packing assistant for Travalate's Shipment Manager. You are given itemsToAllocate (SKUs that must be packed for a purchase order, each with an exact quantity to pack) and historicalPatterns mined from this warehouse's own past shipments on the same platform — which SKUs were typically boxed together, how often (seenNTimes), and the typical quantity of each (typicalQtyPerItem) when that combination was used, plus soloQtyHint as a sensible box size when packing an item alone. Propose a box layout: decide which historical patterns to reuse (favor more frequently-seen patterns and combinations that use up quantities cleanly), and how to size leftovers no pattern fully covers. Every itemCode you use MUST come from itemsToAllocate — never invent one. Within a single box's items array, each itemCode must appear AT MOST ONCE — if an item needs more quantity than fits one line, put the rest in a separate box, never a second line for the same itemCode in the same box. You do not need to hit qtyToAllocate exactly; quantities are reconciled against the real remaining balance afterward — but get as close as you reasonably can using the given patterns. Avoid many boxes with just 1-2 units each unless the historical pattern genuinely only ever used small quantities. Keep note to one short plain sentence, no markdown.";

    const aiResp = callGeminiStructured_(systemPrompt, { itemsToAllocate, historicalPatterns: topPatterns, soloQtyHint }, boxSuggestionSchema_());
    if (!aiResp.ok) return fallbackResult;

    const reconciled = reconcileAiBoxes_(aiResp.data.boxes, allowedItemCodes, mined.itemCodeToSkuInfo, mined.poItems);
    if (!reconciled) return fallbackResult;

    return {
      success:true,
      boxes:reconciled.boxes,
      reference:{ platform:mined.platform, shipmentsUsed:mined.shipmentsScanned, mostRecentDate: mined.mostRecentTs?toDateString_(new Date(mined.mostRecentTs)):'', overlapPct:fallback.overlapPct },
      unassigned:fallback.unassigned,
      totalBoxes:reconciled.boxes.length,
      aiUsed:true,
      aiNote: (aiResp.data && aiResp.data.note) || '',
      aiPatchedItems: reconciled.patchedItems
    };
  } catch(err) { return {success:false,reason:"error",message:err.message}; }
}

// ════════════════════════════════════════════════════════════════
//  AI ASSISTANT ("Help") — floating chat, backed by the Gemini API
// ════════════════════════════════════════════════════════════════
// Small internal Q&A/decision-support chat, grounded in this
// spreadsheet's own live data via Gemini's function calling — Gemini
// decides which lookup(s) a question needs, this file runs the REAL
// function against the sheet, and Gemini reasons over the actual
// result rather than guessing. Scope is deliberately narrow: Inventory
// Snapshot (stock + Ship-1/2/3) and Shipment/PO/Invoice status lookups
// — the two data sources actually asked for, not a dump of the whole
// spreadsheet. Conversation history lives client-side only (round-
// tripped through aiAssistantAsk's `history` param) — nothing about
// these chats is written to any sheet.
//
// SETUP REQUIRED, one-time: create a free API key at aistudio.google.com
// (no credit card needed), then in this Apps Script project go to
// Project Settings > Script Properties and add GEMINI_API_KEY = <that
// key>. Nothing here works without it — aiAssistantAsk returns a clear
// setup message instead of a cryptic failure if it's missing. Uses
// gemini-3.5-flash-lite — deliberately the Lite tier, not the full
// Flash model: Google's own quota-exceeded error revealed the full
// gemini-3.5-flash model's free-tier limit is a mere 5 requests/minute
// (published third-party numbers were wrong), which one multi-round
// tool-use question can burn through by itself. Flash-Lite has
// historically gotten a noticeably higher free RPM than its Flash
// sibling every generation so far, at some cost to reasoning depth —
// fine for grounded lookups like this, where the tools do the real
// work and the model mostly just decides which to call and phrases
// the answer. aiAssistantAsk also retries once with a short backoff on
// a 429/quota error before giving up (see AI_ASSISTANT_RETRY_DELAY_MS_
// below). Free-tier requests may also be used by Google to improve
// their models unless billing is enabled on the project behind the
// key — worth knowing given this reads live stock/shipment data.
// Google retires Gemini model IDs on a rolling schedule (gemini-2.5-flash
// was cut off for new callers ahead of its own published shutdown
// date) — check aistudio.google.com/models or the Gemini API docs if
// GEMINI_API_MODEL_ below ever starts erroring with "no longer
// available", and swap in whatever the current stable Flash-Lite-tier
// free model is.
const GEMINI_API_MODEL_ = "gemini-3.5-flash-lite";
const AI_ASSISTANT_RETRY_DELAY_MS_ = 5000; // one retry after a brief pause on a 429/quota-exceeded response
const AI_ASSISTANT_MAX_TOOL_ROUNDS_ = 6; // hard cap on Gemini's own "ask for a tool, read the result, maybe ask again" loop, so one confused question can't loop forever

function geminiApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

/** Tool schemas offered to Gemini on every turn. Keep these narrow and
 *  well-described — the description text IS how Gemini decides which
 *  tool fits a given question, so it's doing real work, not just
 *  documentation. Shape matches Gemini's functionDeclarations format
 *  (parameters, not input_schema). */
function aiAssistantTools_() {
  return [
    {
      name: "get_inventory_snapshot",
      description: "Look up live stock levels and Ship-1/Ship-2/Ship-3 planned-shipment quantities from the Blinkit Shipment Planning inventory snapshot. Filter by warehouse and/or SKU name (partial match, case-insensitive) - omit either to search across all. Returns the most recent snapshot date's figures per matching SKU per warehouse, plus each SKU's Daily Average (DA) and Stock-Out Days (SOD).",
      parameters: {
        type: "object",
        properties: {
          warehouse: { type: "string", description: "Warehouse name or partial name, e.g. \"Bhiwandi\". Omit to search all warehouses." },
          sku: { type: "string", description: "SKU/item name or partial name. Omit to search all SKUs." },
          limit: { type: "integer", description: "Max number of SKU rows to return, default 25." }
        }
      }
    },
    {
      name: "search_shipments",
      description: "Search shipment records by platform, PO number, invoice number, and/or city/warehouse (all partial match, case-insensitive, all optional - omit a filter to not restrict on it). Returns each matching shipment's platform, PO number, invoice number, date, city, total quantity, box count, and whether it has an RO Invoice.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", description: "blinkit, zepto, swiggy, or amazon" },
          poNumber: { type: "string" },
          invoiceNumber: { type: "string" },
          city: { type: "string", description: "City/warehouse name" },
          limit: { type: "integer", description: "Max results, default 20." }
        }
      }
    },
    {
      name: "get_open_po_balance",
      description: "Look up open/partially-fulfilled Purchase Orders (POs) for a PO-driven platform (blinkit, zepto, or swiggy), with remaining quantity still to be shipped against each. Optionally filter to one exact PO number.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", description: "blinkit, zepto, or swiggy (required)" },
          poNumber: { type: "string", description: "Optional - exact PO number to look up a single PO's balance." }
        },
        required: ["platform"]
      }
    },
    {
      name: "get_warehouse_appointments",
      description: "Look up the Warehouse Appointments scratchpad from the Blinkit Shipment Planning tab - each warehouse's noted Shipping Date and Appt (delivery appointment) Date, plus the shared free-text Notes box. Filter by warehouse name (partial match, case-insensitive) - omit to return every warehouse that has an entry.",
      parameters: {
        type: "object",
        properties: {
          warehouse: { type: "string", description: "Warehouse name or partial name. Omit to return all." }
        }
      }
    }
  ];
}

function aiAssistantRunTool_(name, input) {
  input = input || {};
  if (name === "get_inventory_snapshot") return aiToolInventorySnapshot_(input);
  if (name === "search_shipments") return aiToolSearchShipments_(input);
  if (name === "get_open_po_balance") return aiToolPoBalance_(input);
  if (name === "get_warehouse_appointments") return aiToolAppointments_(input);
  return { error: "Unknown tool: " + name };
}

/** Wraps getSnapshotMatrix()/getSnapshotQtyValues() — both of which
 *  return EVERY warehouse/SKU/date, far too much to hand an LLM
 *  wholesale — down to just the matching rows' latest-date figures,
 *  merged with their saved Ship-1/2/3 quantities. */
function aiToolInventorySnapshot_(args) {
  try {
    const whFilter = (args.warehouse || "").toString().trim().toLowerCase();
    const skuFilter = (args.sku || "").toString().trim().toLowerCase();
    const limit = Math.max(1, Math.min(100, parseInt(args.limit, 10) || 25));
    const matrix = getSnapshotMatrix();
    const qtyValues = getSnapshotQtyValues();
    // Ship-1/2/3 are stored against plain column keys "1"/"2"/"3" (see
    // renderQtyCell_'s col param in the HTML - NOT "qty1"/"qty2"/"qty3").
    // Color-marker rows use "1c"/"2c"/"3c" instead (snapQtyColorKey_) so
    // they never collide with the plain quantity keys read here.
    const qtyByWhItem = {}; // "warehouse||itemId" -> {"1":val,"2":val,"3":val}
    qtyValues.forEach(function (r) {
      if (r.itemId === "__WH__") return;
      if (r.col !== "1" && r.col !== "2" && r.col !== "3") return; // skip color-marker rows ("1c" etc.)
      const key = r.warehouse + "||" + r.itemId;
      if (!qtyByWhItem[key]) qtyByWhItem[key] = {};
      qtyByWhItem[key][r.col] = r.value;
    });
    const latestDate = matrix.dates.length ? matrix.dates[matrix.dates.length - 1] : null;
    const out = [];
    for (const wh of matrix.warehouses) {
      if (whFilter && wh.name.toLowerCase().indexOf(whFilter) === -1) continue;
      for (const sku of wh.skus) {
        const nameMatch = !skuFilter ||
          (sku.itemName || "").toLowerCase().indexOf(skuFilter) !== -1 ||
          (sku.itemId || "").toLowerCase().indexOf(skuFilter) !== -1;
        if (!nameMatch) continue;
        const key = wh.name + "||" + sku.itemId;
        const qty = qtyByWhItem[key] || {};
        out.push({
          warehouse: wh.name,
          sku: sku.itemName || sku.itemId,
          itemId: sku.itemId,
          asOfDate: latestDate,
          stock: latestDate && sku.values[latestDate] !== undefined ? sku.values[latestDate] : null,
          dailyAverage: sku.da,
          stockOutDays: sku.sod,
          ship1: qty["1"] || "",
          ship2: qty["2"] || "",
          ship3: qty["3"] || ""
        });
        if (out.length >= limit) return { asOfDate: latestDate, rows: out, truncated: true };
      }
    }
    return { asOfDate: latestDate, rows: out, truncated: false };
  } catch (err) {
    return { error: err.message };
  }
}

/** Wraps getShipments() (returns EVERY undeleted shipment) down to
 *  just the matching, summarized rows. */
function aiToolSearchShipments_(args) {
  try {
    const platformF = (args.platform || "").toString().trim().toLowerCase();
    const poF = (args.poNumber || "").toString().trim().toLowerCase();
    const invF = (args.invoiceNumber || "").toString().trim().toLowerCase();
    const cityF = (args.city || "").toString().trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, parseInt(args.limit, 10) || 20));
    const all = getShipments(null, null);
    const out = [];
    for (const s of all) {
      if (platformF && (s.platform || "").toLowerCase().indexOf(platformF) === -1) continue;
      if (poF && (s.poNumber || "").toLowerCase().indexOf(poF) === -1) continue;
      if (invF && (s.invoiceNumber || "").toLowerCase().indexOf(invF) === -1) continue;
      if (cityF && (s.city || "").toLowerCase().indexOf(cityF) === -1) continue;
      let totalQty = 0;
      (s.boxes || []).forEach(function (b) { (b.items || []).forEach(function (it) { totalQty += parseInt(it.qty, 10) || 0; }); });
      out.push({
        platform: s.platform, poNumber: s.poNumber, invoiceNumber: s.invoiceNumber || "(none yet)",
        date: s.date, city: s.city, totalQty: totalQty, boxCount: (s.boxes || []).length, hasRoInvoice: s.hasRoInvoice
      });
      if (out.length >= limit) return { rows: out, truncated: true };
    }
    return { rows: out, truncated: false };
  } catch (err) {
    return { error: err.message };
  }
}

function aiToolPoBalance_(args) {
  try {
    const platform = (args.platform || "").toString().trim().toLowerCase();
    if (!poPlatformConfig_(platform)) return { error: "platform must be blinkit, zepto, or swiggy." };
    let pos = getOpenPosForPlatform_(platform);
    const poF = (args.poNumber || "").toString().trim().toLowerCase();
    if (poF) pos = pos.filter(function (p) { return (p.poNumber || "").toLowerCase() === poF; });
    return { rows: pos };
  } catch (err) {
    return { error: err.message };
  }
}

/** Wraps getSnapshotAppointments() (the Warehouse Appointments popup on
 *  the Blinkit Shipment Planning tab) down to just the rows that
 *  actually have something in them (the sheet is always padded to a
 *  5-row minimum with blanks, which would otherwise clutter the
 *  result), optionally filtered by warehouse. */
function aiToolAppointments_(args) {
  try {
    const whFilter = (args.warehouse || "").toString().trim().toLowerCase();
    const data = getSnapshotAppointments();
    let rows = (data.rows || []).filter(function (r) {
      return (r.warehouse || "").toString().trim() || (r.shippingDate || "").toString().trim() || (r.apptDate || "").toString().trim();
    });
    if (whFilter) rows = rows.filter(function (r) { return (r.warehouse || "").toLowerCase().indexOf(whFilter) !== -1; });
    return { rows: rows, notes: data.notes || "" };
  } catch (err) {
    return { error: err.message };
  }
}

/** Public: one turn of the Help chat. `history` is the JSON-stringified
 *  array of prior Gemini-format `contents` the CLIENT is holding for
 *  this session (never stored server-side) - passed back in so
 *  multi-turn context works without any server-side session store.
 *  Runs Gemini's own function-calling loop internally, up to
 *  AI_ASSISTANT_MAX_TOOL_ROUNDS_ rounds of "Gemini asks for a tool ->
 *  this file runs the real function against the sheet -> the result
 *  goes back to Gemini" - and returns only the final plain-text reply
 *  plus the updated history for the client to hold onto for its next
 *  question. */
function aiAssistantAsk(userMessage, history) {
  try {
    const apiKey = geminiApiKey_();
    if (!apiKey) {
      return { success: false, message: "AI Assistant isn't set up yet - add a GEMINI_API_KEY in Project Settings > Script Properties (get a free one at aistudio.google.com)." };
    }
    let contents = [];
    try { contents = JSON.parse(history || "[]"); } catch (e) { contents = []; }
    contents.push({ role: "user", parts: [{ text: userMessage }] });

    const systemPrompt = "You are the internal Help assistant inside Travalate's Shipment Manager tool. You can look up live inventory snapshot data (stock, Ship-1/2/3, Daily Average, Stock-Out Days), shipment/PO/invoice records, and the Warehouse Appointments scratchpad (Shipping Date, Appt Date, and shared Notes per warehouse) via the tools provided. Always use a tool to check real data before answering any question about stock, shipments, POs, or appointments - never guess or make up numbers or dates. When making a shipment-planning suggestion, ground it explicitly in the figures you looked up (state the numbers you're basing it on). If a lookup returns nothing, say so plainly rather than inventing a plausible-sounding answer. If the message is a bare name/phrase rather than a clear question (e.g. just a warehouse name with no question attached), do NOT guess by calling tools repeatedly - instead reply in plain text asking what specifically they want to know about it (e.g. stock levels, a specific SKU, appointment dates, or shipment status). Keep replies concise and in plain text (no markdown headers) since this renders in a small chat panel.";

    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_API_MODEL_ + ":generateContent";

    for (let round = 0; round < AI_ASSISTANT_MAX_TOOL_ROUNDS_; round++) {
      let resp = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { "x-goog-api-key": apiKey },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          contents: contents,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools: [{ functionDeclarations: aiAssistantTools_() }]
        })
      });
      let status = resp.getResponseCode();

      // One retry after a short pause on a rate-limit/quota response —
      // the free tier's per-minute cap is easy to brush against with a
      // multi-round tool-use question, and a brief pause is often all
      // that's needed rather than failing the whole question outright.
      if (status === 429) {
        Utilities.sleep(AI_ASSISTANT_RETRY_DELAY_MS_);
        resp = UrlFetchApp.fetch(url, {
          method: "post",
          contentType: "application/json",
          headers: { "x-goog-api-key": apiKey },
          muteHttpExceptions: true,
          payload: JSON.stringify({
            contents: contents,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            tools: [{ functionDeclarations: aiAssistantTools_() }]
          })
        });
        status = resp.getResponseCode();
      }

      const body = JSON.parse(resp.getContentText());
      if (status !== 200) {
        const apiMsg = body.error && body.error.message ? body.error.message : resp.getContentText();
        const friendly = status === 429
          ? "Free-tier rate limit hit - wait a moment and try again. (" + apiMsg + ")"
          : "Gemini API error: " + apiMsg;
        return { success: false, message: friendly };
      }

      const candidate = body.candidates && body.candidates[0];
      const modelParts = (candidate && candidate.content && candidate.content.parts) || [];
      if (!modelParts.length) {
        // Most common cause: the prompt/response was blocked by Gemini's
        // own safety filters (candidate.finishReason === "SAFETY") rather
        // than a real error - surfaced plainly instead of a blank reply.
        const reason = candidate && candidate.finishReason;
        return { success: false, message: reason ? "Gemini didn't return an answer (" + reason + ")." : "Gemini API returned no response." };
      }
      contents.push({ role: "model", parts: modelParts });

      const functionCalls = modelParts.filter(function (p) { return !!p.functionCall; });
      if (functionCalls.length) {
        const responseParts = functionCalls.map(function (p) {
          const result = aiAssistantRunTool_(p.functionCall.name, p.functionCall.args);
          return { functionResponse: { name: p.functionCall.name, response: result } };
        });
        contents.push({ role: "user", parts: responseParts });
        continue; // let Gemini see the tool result(s) and continue or finish
      }

      const textPart = modelParts.filter(function (p) { return typeof p.text === "string"; })[0];
      return { success: true, reply: textPart ? textPart.text : "(no reply)", history: JSON.stringify(contents) };
    }
    return { success: false, message: "Took too many lookup steps to answer - try a more specific question." };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ════════════════════════════════════════════════════════════════
//  PRODUCT LABEL PRINTING — TSC TSPL generator + QZ Tray, ported from
//  the standalone Travalate Label System into this project. Blinkit
//  only for now (see generateSkuLabelTspl_impl_'s platform check) —
//  the "🟢 All" / "🟡 Custom" print buttons live in the Balance popup
//  on a saved Blinkit shipment (renderPoBalancePopup_'s dummy-free,
//  non-live branch in ShipmentManagerIndex.html), printing that SKU's
//  own Packed quantity (or a manually-typed quantity) straight to a
//  QZ-Tray-connected label printer.
//
//  DATA SOURCE: unlike the standalone app's separate Products +
//  PlatformData sheets, label fields live directly on SKU_MASTER (see
//  migrateSkuMasterAddLabelColumns above) — one shared source of truth
//  with the rest of Shipment Manager instead of a second place to keep
//  a SKU's details in sync. Barcode and MRP reuse the SAME per-platform
//  columns everything else already reads (roFieldsForPlatform_);
//  MFG_DATE/PRODUCT_TYPE/COLOR/COUNTRY/PACK_QTY are the only genuinely
//  new columns, since those don't vary by platform.
//
//  QZ TRAY SIGNING SETUP (one-time, same as the standalone app): run
//  setQzPrivateKey() once from this Apps Script project's editor —
//  the private key below is the SAME key/cert pair already in use for
//  the standalone label app, just needs to be persisted into THIS
//  project's own Script Properties store (a separate project = a
//  separate PropertiesService, even with the identical key value).
// ════════════════════════════════════════════════════════════════

const LABEL_CONFIG_ = {
  LABEL_WIDTH_MM: 60,
  LABEL_HEIGHT_MM: 40,
  GAP_MM: 3,
  DPI: 300,
  DENSITY: 8,
  SPEED: 4,

  BRAND: "Travalate",

  CUSTOMER_CARE: {
    contact: "6358606060",
    email: "support@travalate.com",
    website: "www.travalate.com",
  },

  MANUFACTURER: {
    name: "Sethi Industries",
    address: "H-1177, Sitapura Industrial Area, Jaipur-302022",
  },

  // Public half of the QZ Tray signing cert — safe to send to the
  // browser. Paired with the private key stored in Script Properties
  // via setQzPrivateKey() below.
  QZ_CERTIFICATE: `-----BEGIN CERTIFICATE-----
MIIECzCCAvOgAwIBAgIGAZ9ge7GEMA0GCSqGSIb3DQEBCwUAMIGiMQswCQYDVQQG
EwJVUzELMAkGA1UECAwCTlkxEjAQBgNVBAcMCUNhbmFzdG90YTEbMBkGA1UECgwS
UVogSW5kdXN0cmllcywgTExDMRswGQYDVQQLDBJRWiBJbmR1c3RyaWVzLCBMTEMx
HDAaBgkqhkiG9w0BCQEWDXN1cHBvcnRAcXouaW8xGjAYBgNVBAMMEVFaIFRyYXkg
RGVtbyBDZXJ0MB4XDTI2MDcxMzExNTU0NloXDTQ2MDcxMzExNTU0NlowgaIxCzAJ
BgNVBAYTAlVTMQswCQYDVQQIDAJOWTESMBAGA1UEBwwJQ2FuYXN0b3RhMRswGQYD
VQQKDBJRWiBJbmR1c3RyaWVzLCBMTEMxGzAZBgNVBAsMElFaIEluZHVzdHJpZXMs
IExMQzEcMBoGCSqGSIb3DQEJARYNc3VwcG9ydEBxei5pbzEaMBgGA1UEAwwRUVog
VHJheSBEZW1vIENlcnQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDB
Mmt0ZxfcikV5cWtSl6Ogd5vE6vT1epJJIE25UAFYYsYbLwki/4BrOZw9GR4o+c50
a0lR9GM2pcpkZNT6h6noveebe7pWQyhJ8e4OngxdfodLhPxCdn+ribsUMgo7ZWs0
0kRX2Z2el9hyKo2AqYinta3BjYvf1qAuY7oCusPzp5FQglKlFF9/DpGn3U3L/N7K
ceT0ex54KBpPWwjriq7tVsZgiFZZOWCVaXXG1eB/Y/Zu55UBLmEfYEGR7Un5oHKi
7mF7Y6M7dLK8XT37vv5ZhkKkpppV2e98FcXL4GFMGKUevBQ4EVSNPECLDRe8pNIg
+EgHTMZqMIoQEv7+YJ0jAgMBAAGjRTBDMBIGA1UdEwEB/wQIMAYBAf8CAQEwDgYD
VR0PAQH/BAQDAgEGMB0GA1UdDgQWBBSQY/Ml3ICCM/PSbcSruvBj2jNlJTANBgkq
hkiG9w0BAQsFAAOCAQEAs01cpdFUS2CoKnwx+OCMSPj2QKfA507ZESgT6W9tifDR
80WpOS48zTkNcCO2MZI5WLh9NPiNfODymNEQku86XpwVVix3DAnoIKRVmahz3BGq
6jx91zqSOILcI9N4GN9HbqZtzW4YixK45OSsyw9ONV42U9FgWvxcvAm5Hwz6pKBk
bRbyYLCFByc+ErKqH742Xn+fglW2kMe3sevcgvO+W7IIxCD2+8dnlKBmrzhOQP0c
vn4n9ri3V04nIejL7spWjmd30HdsdK1r8h+81Dc2LyviPRnv7a+Er/IpS63iATr+
w0NWx2YtzhOMCVH5ui1Pl3OGDiqJcX9A/PG7XF2iRg==
-----END CERTIFICATE-----
`,
};

function labelDotsPerMm_() {
  return LABEL_CONFIG_.DPI / 25.4;
}
function labelMmToDots_(mm) {
  return Math.round(mm * labelDotsPerMm_());
}
function labelPlatformInitial_(platform) {
  return (platform || "?").charAt(0).toUpperCase();
}
function labelTsplEscape_(str) {
  return String(str == null ? "" : str).replace(/"/g, "'");
}

/** Estimates the physical printed width (in mm) of a Code128 barcode.
 *  All-numeric values render as Code128 Subset C (2 digits per symbol);
 *  anything else (alphanumeric SKU/ASIN-style values) renders as
 *  Subset B (1 character per symbol). Official Code128 length formula:
 *  L = (11*C + 35) * X, where C is the symbol count and X is the
 *  narrow-bar dot width. */
function labelEstimateCode128Width_(value, narrowBarWidthDots) {
  const str = String(value || "");
  const isAllDigits = /^\d+$/.test(str);
  const symbols = isAllDigits ? Math.ceil(str.length / 2) : str.length;
  const totalUnits = 11 * symbols + 35;
  return (totalUnits * narrowBarWidthDots) / labelDotsPerMm_();
}

/** Wider narrow-bar for all-numeric UPC-style codes (Subset C's digit-
 *  pairing leaves plenty of spare room); narrower for alphanumeric
 *  codes (already close to the label's width limit). */
function labelPickNarrowBarWidth_(value) {
  const isAllDigits = /^\d+$/.test(String(value || ""));
  return isAllDigits ? 5 : 3;
}

function labelTruncate_(str, maxChars) {
  str = String(str || "");
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars - 3) + "...";
}

/** Wraps text to exactly 2 lines on word boundaries (never mid-word).
 *  If what's left after line 1 still doesn't fit line 2, it's
 *  truncated with "..." — only kicks in for genuinely long values. */
function labelWrapToTwoLines_(str, maxCharsPerLine) {
  str = String(str || "").trim();
  if (str.length <= maxCharsPerLine) return [str, ""];

  const words = str.split(/\s+/);
  let line1 = "";
  let i = 0;
  for (; i < words.length; i++) {
    const candidate = line1 ? line1 + " " + words[i] : words[i];
    if (candidate.length > maxCharsPerLine) break;
    line1 = candidate;
  }
  if (!line1) {
    line1 = words[0].slice(0, maxCharsPerLine);
    i = 1;
  }
  const line2Raw = words.slice(i).join(" ");
  const line2 = labelTruncate_(line2Raw, maxCharsPerLine);
  return [line1, line2];
}

function labelManufacturerLines_(country) {
  const isIndia = String(country || "India").toLowerCase().startsWith("ind");
  const header = isIndia ? "Manufactured & Packed By:" : "Packed By:";
  return [header, LABEL_CONFIG_.MANUFACTURER.name, LABEL_CONFIG_.MANUFACTURER.address];
}

/** Builds the raw TSPL command stream for one SKU's label, ported
 *  as-is from the standalone Travalate Label System (60mm x 40mm,
 *  platform-initial box + barcode + product name + two-column detail
 *  block). `data` is the labelData object built by
 *  generateSkuLabelTspl_impl_ below. */
function buildLabelTspl_(data, qty) {
  const widthMm = LABEL_CONFIG_.LABEL_WIDTH_MM;
  const heightMm = LABEL_CONFIG_.LABEL_HEIGHT_MM;
  const gapMm = LABEL_CONFIG_.GAP_MM;

  const lines = [];
  lines.push(`SIZE ${widthMm} mm,${heightMm} mm`);
  lines.push(`GAP ${gapMm} mm,0 mm`);
  lines.push(`DIRECTION 1`);
  lines.push(`DENSITY ${LABEL_CONFIG_.DENSITY}`);
  lines.push(`SPEED ${LABEL_CONFIG_.SPEED}`);
  lines.push(`CLS`);

  // ---- Platform initial box (top-left) ----
  const boxX = 1.5, boxY = 1.5, boxW = 9, boxH = 9;
  lines.push(
    `BOX ${labelMmToDots_(boxX)},${labelMmToDots_(boxY)},${labelMmToDots_(boxX + boxW)},${labelMmToDots_(boxY + boxH)},2`
  );
  lines.push(
    `TEXT ${labelMmToDots_(boxX + 3)},${labelMmToDots_(boxY + 2.4)},"5",0,1,1,"${labelPlatformInitial_(data.platform)}"`
  );

  // ---- Barcode (Code128), to the right of the platform box ----
  const barcodeAreaX = boxX + boxW + 1;
  const barcodeAreaRightMargin = 1;
  const barcodeAreaWidth = widthMm - barcodeAreaX - barcodeAreaRightMargin;
  const barcodeHmm = 8;
  const narrowBar = labelPickNarrowBarWidth_(data.barcodeValue);
  const estimatedBarcodeWidthMm = labelEstimateCode128Width_(data.barcodeValue, narrowBar);
  const barcodeCenterOffset = Math.max(0, (barcodeAreaWidth - estimatedBarcodeWidthMm) / 2);
  const barcodeX = barcodeAreaX + barcodeCenterOffset;
  lines.push(
    `BARCODE ${labelMmToDots_(barcodeX)},${labelMmToDots_(boxY)},"128",${labelMmToDots_(barcodeHmm)},0,0,${narrowBar},${narrowBar},"${labelTsplEscape_(data.barcodeValue)}"`
  );

  // ---- Barcode value text, centered under the BARCODE ITSELF (not the
  // whole label — the barcode sits well right of the platform box, so
  // centering against the full label width would push the text off to
  // one side of the actual bars). Estimated the same way the barcode
  // bars' own width is estimated: Font "2" nominal 12-dot char cell.
  // Clamped so it can never start left of the barcode's own left edge,
  // in case a very short numeric value would otherwise center further
  // left than that.
  let y = Math.max(boxY + boxH, boxY + barcodeHmm) + 1.5;
  const textLeftMargin = 3;
  const barcodeTextWidthMm = String(data.barcodeValue || "").length * (12 / labelDotsPerMm_());
  const barcodeTextX = Math.max(barcodeAreaX, barcodeX + (estimatedBarcodeWidthMm - barcodeTextWidthMm) / 2);
  lines.push(`TEXT ${labelMmToDots_(barcodeTextX)},${labelMmToDots_(y)},"2",0,1,1,"${labelTsplEscape_(data.barcodeValue)}"`);
  y += 2.3;
  y += 1;

  // ---- Product name, left-aligned, max 2 lines with "..." fallback ----
  const nameLines = labelWrapToTwoLines_(data.productName, 53);
  lines.push(`TEXT ${labelMmToDots_(textLeftMargin)},${labelMmToDots_(y)},"2",0,1,1,"${labelTsplEscape_(nameLines[0])}"`);
  y += 2.3;
  if (nameLines[1]) {
    lines.push(`TEXT ${labelMmToDots_(textLeftMargin)},${labelMmToDots_(y)},"2",0,1,1,"${labelTsplEscape_(nameLines[1])}"`);
  }
  y += 2.3;
  y += 1;

  // ---- Two-column block: left = product/platform details, right =
  // manufacturer + customer care ----
  const leftX = 3;
  const rightX = widthMm / 2 + 1;
  let leftY = y;
  let rightY = y;
  const leftLineStep = (heightMm - y - 1.5) / 9;
  const rightLineStep = (heightMm - y - 1.5) / 8;
  // Font "2" (used here until now) measured wider in real prints than
  // its nominal 12-dot spec — at COL_MAX_CHARS=27 that was enough to run
  // a long SKU straight into the right column's text, and independently
  // run the wrapped manufacturer address past the label's own right
  // edge (both reported against a physical print). Font "1" is TSC's
  // next size down — already proven legible on this exact printer (the
  // "(Inclusive of Taxes)" sub-line below has used it all along) — and
  // buys enough real width back to fit every fixed string here (the
  // longest, "Manufactured & Packed By:", is 25 characters) with actual
  // margin to spare, rather than sitting right at the edge like before.
  const FONT = "1";
  const COL_MAX_CHARS = 34;

  const leftLines = [
    `SKU: ${labelTsplEscape_(data.sku)}`,
    `MRP: Rs. ${labelTsplEscape_(data.mrp)}.00`,
    `MFG Date: ${labelTsplEscape_(data.mfgDate)}`,
    `Qty: ${labelTsplEscape_(data.quantity)}`,
    `Brand: ${labelTsplEscape_(data.brand)}`,
    `Type: ${labelTsplEscape_(labelTruncate_(data.productType, 16))}`,
    `Color: ${labelTsplEscape_(data.color)}`,
    `Origin: ${labelTsplEscape_(data.country)}`,
  ];

  leftLines.forEach((txt, idx) => {
    lines.push(`TEXT ${labelMmToDots_(leftX)},${labelMmToDots_(leftY)},"${FONT}",0,1,1,"${labelTruncate_(txt, COL_MAX_CHARS)}"`);
    leftY += leftLineStep;
    if (idx === 1) {
      lines.push(`TEXT ${labelMmToDots_(leftX)},${labelMmToDots_(leftY)},"1",0,1,1,"(Inclusive of Taxes)"`);
      leftY += leftLineStep;
    }
  });

  const mfgHeaderAndName = labelManufacturerLines_(data.country).slice(0, 2);
  const addressLines = labelWrapToTwoLines_(LABEL_CONFIG_.MANUFACTURER.address, COL_MAX_CHARS);
  const rightLines = mfgHeaderAndName
    .concat(addressLines.filter((l) => l !== ""))
    .concat([
      "Customer Care:",
      `Ph: ${LABEL_CONFIG_.CUSTOMER_CARE.contact}`,
      LABEL_CONFIG_.CUSTOMER_CARE.email,
      LABEL_CONFIG_.CUSTOMER_CARE.website,
    ]);

  rightLines.forEach((txt) => {
    lines.push(`TEXT ${labelMmToDots_(rightX)},${labelMmToDots_(rightY)},"${FONT}",0,1,1,"${labelTruncate_(labelTsplEscape_(txt), COL_MAX_CHARS)}"`);
    rightY += rightLineStep;
  });

  lines.push(`PRINT ${qty},1`);

  return lines.join("\r\n") + "\r\n";
}

/** Generates the TSPL for one SKU's label, `qty` copies. Blinkit only
 *  for now — the SKU's Blinkit barcode/UPC and MRP (from SKU_MASTER,
 *  same columns everything else uses) must both be present, or this
 *  returns a clear "map it first" error instead of printing a blank/
 *  wrong barcode. */
function generateSkuLabelTspl_impl_(sku, platform, qty) {
  try {
    platform = (platform || "blinkit").toString().trim().toLowerCase();
    if (platform !== "blinkit") {
      return { success: false, message: "Product Label printing is only available for Blinkit right now." };
    }
    sku = (sku || "").toString().trim();
    if (!sku) return { success: false, message: "No SKU given." };
    const qtyNum = Math.max(0, parseInt(qty, 10) || 0);
    if (!qtyNum) return { success: false, message: "Quantity must be at least 1." };

    const skuRows = getSkuData();
    const row = skuRows.find((r) => r.sku === sku);
    if (!row) return { success: false, message: 'SKU "' + sku + '" not found in SKU_MASTER.' };

    const roFields = roFieldsForPlatform_(platform);
    const barcodeValue = (row[roFields.upcField] || "").toString().trim();
    if (!barcodeValue) {
      return { success: false, message: 'SKU "' + sku + '" has no Blinkit barcode/UPC in SKU_MASTER — add one in the SKU Master tab before printing labels.' };
    }
    if (!row.mrp) {
      return { success: false, message: 'SKU "' + sku + '" has no MRP in SKU_MASTER — add one in the SKU Master tab before printing labels.' };
    }

    const labelData = {
      platform: platform.charAt(0).toUpperCase() + platform.slice(1),
      productName: row.description || sku,
      brand: LABEL_CONFIG_.BRAND,
      country: row.country || "India",
      barcodeValue: barcodeValue,
      sku: sku,
      mrp: row.mrp,
      mfgDate: row.mfgDate,
      quantity: row.packQty || "1",
      productType: row.productType,
      color: row.color,
    };

    const tspl = buildLabelTspl_(labelData, qtyNum);
    const safeSku = sku.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename =
      "label_" + labelData.platform + "_" + safeSku + "_" +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Etc/UTC", "yyyyMMdd_HHmmss") + ".tspl";

    return { success: true, tspl: tspl, filename: filename };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Public wrapper called from the Balance popup's 🟢 All / 🟡 Custom
 *  buttons. */
function generateSkuLabelTspl(sku, platform, qty) {
  return generateSkuLabelTspl_impl_(sku, platform, qty);
}

// ---------------------------------------------------------------
// QZ TRAY SIGNING — stops the repeated "Allow" popups. Ported as-is
// from the standalone label app; see that project's SETUP_GUIDE.md for
// the one-time cert-generation walkthrough. The private key must NEVER
// be sent to or stored in the browser — it stays in Script Properties
// (server-side only) and is used to sign each request on demand via
// signQzRequest(), which the page calls instead of signing locally.
// ---------------------------------------------------------------

/** Run this ONCE from the Apps Script editor (select setQzPrivateKey in
 *  the function dropdown, click Run) to store the private key in this
 *  project's own Script Properties. Never expose this value in
 *  ShipmentManagerIndex.html or any client-side code. */
function setQzPrivateKey() {
  const PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDBMmt0ZxfcikV5
cWtSl6Ogd5vE6vT1epJJIE25UAFYYsYbLwki/4BrOZw9GR4o+c50a0lR9GM2pcpk
ZNT6h6noveebe7pWQyhJ8e4OngxdfodLhPxCdn+ribsUMgo7ZWs00kRX2Z2el9hy
Ko2AqYinta3BjYvf1qAuY7oCusPzp5FQglKlFF9/DpGn3U3L/N7KceT0ex54KBpP
Wwjriq7tVsZgiFZZOWCVaXXG1eB/Y/Zu55UBLmEfYEGR7Un5oHKi7mF7Y6M7dLK8
XT37vv5ZhkKkpppV2e98FcXL4GFMGKUevBQ4EVSNPECLDRe8pNIg+EgHTMZqMIoQ
Ev7+YJ0jAgMBAAECggEAI/RCrCiNd8Uh1c6GRxoiYPgxfI2vZcnYVJSW8mBRx8Wm
EaQIwsMi/pF7oqE8jCqlQeQ/gmmFV0O2bUWYn0FFHSPOaRC3JlucMVq9T2oZagLk
oejPW30bGGzq7IC9h71BnNRu1JySqVOf++swZ1vlqzRz8Dvr5o3WRJvZn61rTzoy
zkd+kserH2nLTk0rZm4GuQNAywnlB7o4yhHgXSwB/l7UwxVVR0J+tWoFuLT7otqy
cLx2mkBgPCKhnn4bsJH2Vocc4DHbGUKAIxSNVpA3fCxWJmZBescdJQFxVkxHE+3H
Mha+j6l+Em+LwPhBnrTuYppdM2UYFGVkDRT8Y0iM5QKBgQDl1T+/8uMZFTBRU7fR
IWAKBgxKXslUbLeJYwfT+xQcCJP0IbAdpaZfmyqanq7naD16e5oyoy0U1l3S/jIy
4Cil4ErOswWg0wbaO4lL2ixcL4JApPtLXO4p33PWevugN4OIsjnAY7EvGaGWd0bQ
ULm8qVLffJzHI7kFJsjP0KY0/QKBgQDXMV7JQ2omA6vhz3YFG4HDBQZDNZQ8AVwB
pE5evTg9208SOUJmgmZ5mKjvUASK9hWtASr/Ah+YyBrA6rJSv45Cu5O1DWMCX79v
P8GPhPp/5p8oBubum7buojFm+QoAv4O38FXxFfo/SpPUCQGy4PSUaXOwJHY5R8Ij
b59kbyTEnwKBgATimH1K+1rAIYvI/MI8NF9iK4a1JxBdUzVfXn45+v5xjDuHL8gh
ijzD/o7UyqDujUf6Mpfa8g1cVRg0APsl2pdUAiMMmRUHB0FCPLPZClJXTCx1lUXP
ztwi/MJVUN3h8DDKoQGe3NhEcjPRizbIUHpbGwDXFDoDX15lqaUJKU89AoGABBCk
r7ycRrePCab3ncUVQG/Z3G8oq7GC4W0PJe8BHvoDll6KiJEyCl394vdp/o4Dfs8k
1shdfG9bQgWs9K81qsEMW0Eze5n/bcSQjXt/l+btXr4yopNCc2OQ91cA/16eyFy7
4t/9aDCqdjjtVUm2lQ8g5lTp/s8CNdUn96e51BUCgYEAnR1+ngqdWPqQ3RtB3TiX
87UXYOxWe9b54hR+dpgewIO/VK+6uIVKKLrWyhl1unaVWO+rv7/iyWCcVUV5/ZOI
ShRBbClANV4oHDTJNm4tjFpztkQUxIIy0y0h+U3f33VUF0MDfkBIAKN5xM6T8lCQ
2XnWUxRxz71RhUuG7HVu6rU=
-----END PRIVATE KEY-----
`;
  PropertiesService.getScriptProperties().setProperty("QZ_PRIVATE_KEY", PRIVATE_KEY_PEM);
  Logger.log("QZ Tray private key saved to Script Properties.");
}

/** Returns the QZ Tray digital certificate text (the PUBLIC half) so
 *  the page can supply it via qz.security.setCertificatePromise(). */
function getQzCertificate() {
  return LABEL_CONFIG_.QZ_CERTIFICATE || "";
}

/** Signs a value on the server using the private key stored in Script
 *  Properties, returning the base64 signature QZ Tray expects. The
 *  page calls this via google.script.run instead of signing locally,
 *  so the private key never leaves the server. */
function signQzRequest(valueToSign) {
  const privateKey = PropertiesService.getScriptProperties().getProperty("QZ_PRIVATE_KEY");
  if (!privateKey) {
    throw new Error("QZ Tray private key not configured — run setQzPrivateKey() once from the Apps Script editor first.");
  }
  const signatureBytes = Utilities.computeRsaSha256Signature(valueToSign, privateKey);
  return Utilities.base64Encode(signatureBytes);
}

// NOTE: the last-used label printer is deliberately NOT remembered here
// via PropertiesService — this app is explicitly built to run on shared
// packing-station PCs (see the sessionStorage comment on SESSION_STORAGE_KEY_
// in ShipmentManagerIndex.html), and a label printer is physically wired
// to one PC, not to whichever employee happens to be logged in right now.
// Worse, this web app typically runs "Execute as: Me" so every visitor
// shares ONE effective script user — PropertiesService.getUserProperties()
// would be the SAME store for every packing station, not a separate one
// per PC, so different stations' printer choices would overwrite each
// other. The printer choice is saved client-side in localStorage instead
// (see initQzTrayForLabels_ in ShipmentManagerIndex.html) — genuinely
// per-browser/per-PC, and persists across logins on that same PC.
