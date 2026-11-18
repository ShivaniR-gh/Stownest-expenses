/**
 * StowNest Expense Manager — Google Apps Script backend
 * -----------------------------------------------------
 * Bound to the "StowNest Expense Manager" spreadsheet.
 * Deployed as a Web App: Execute as = Me, Who has access = Anyone within stownest.com.
 * Apps Script serves the frontend (Index.html) and the page calls api() through
 * google.script.run. Every action except login needs a valid session token.
 *
 * Script Properties used:
 *   APP_PASSCODE     (required, set by you)  shared employee passcode
 *   BILLS_FOLDER_ID  (set by setup())        Drive folder for bills
 *   LAST_EXPENSE_SEQ (managed by script)     last issued expense number
 */

const CONFIG = {
  APP_TITLE: 'StowNest Expense Manager',
  SHEETS: { EXPENSES: 'Expenses', CATEGORIES: 'Categories', LISTS: 'Lists' },
  ID_PREFIX: 'EXP-',
  ID_PAD: 6,
  MAX_FILE_BYTES: 5 * 1024 * 1024, // 5 MB
  ALLOWED_MIME: { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' },
  TOKEN_TTL_SECONDS: 6 * 60 * 60,   // 6 hours (CacheService maximum)
  MAX_LOGIN_FAILS: 30,              // per 10-minute window
  LOCK_WAIT_MS: 30000,
  BILLS_FOLDER_NAME: 'StowNest Expense Bills',
};

const EXPENSE_HEADERS = [
  'Expense ID', 'Expense Date', 'Main Category', 'Subcategory', 'City', 'Warehouse',
  'Department', 'Description', 'Amount', 'Vendor / Supplier Name', 'Payment Mode',
  'Invoice Number', 'Bill File ID', 'Bill Link', 'Remarks', 'Created At', 'Updated At',
];

// Object keys in the same order as EXPENSE_HEADERS
const EXPENSE_KEYS = [
  'id', 'date', 'mainCategory', 'subcategory', 'city', 'warehouse',
  'department', 'description', 'amount', 'vendor', 'paymentMode',
  'invoiceNumber', 'billFileId', 'billLink', 'remarks', 'createdAt', 'updatedAt',
];

// Lists sheet: one column per list. "Warehouse City" sits beside "Warehouses",
// row by row, saying which city each warehouse belongs to.
const LIST_HEADERS = ['Cities', 'Warehouses', 'Warehouse City', 'Departments', 'Payment Modes'];

const DEFAULT_CATEGORIES = [
  ['Warehouse Rent', []],
  ['Labour & Manpower Payments', []],
  ['Electricity & Wi-Fi Bills', []],
  ['Drinking Water, Tea & Coffee Expenses', []],
  ['Crane Usage Charges', []],
  ['Packaging Material Expenses', []],
  ['Stationery & Pest Control Expenses', []],
  ['CCTV Expenses', ['Installation', 'AMC / Service & Maintenance', 'Repairs / Replacement']],
  ['IT Assets', ['Laptop', 'Mobile Phones', 'Other IT Equipment']],
  ['Furniture Expenses', []],
  ['Material Handling Equipment', ['Hand Pallet Trolleys', 'Racks', 'Other Warehouse Equipment']],
  ['UPS Expenses', ['UPS Batteries', 'Maintenance & Service']],
  ['Warehouse Insurance', []],
  ['Vehicle Expenses', ['Vehicle Insurance', 'Vehicle Servicing & Repairs', 'National Permit Renewal', 'Road Tax', 'FC']],
  ['Logistics Expenses', ['Pickup', 'Delivery', 'Local Shifting', 'Interstate Shifting', 'Interstate Delivery',
    'Interstate Pickup', 'B2B Transportation', 'Cancellation Charges']],
  ['Warehouse Repair & Maintenance', []],
  ['Fixed Asset Purchase Expenses', []],
  ['Other Expenses', []],
];

const DEFAULT_LISTS = {
  cities: ['Bengaluru', 'Chennai', 'Hyderabad', 'Mumbai', 'Pune'],
  warehouses: [ // [warehouse, city]
    ['Bengaluru Warehouse 1 (placeholder)', 'Bengaluru'],
    ['Chennai Warehouse 1 (placeholder)', 'Chennai'],
    ['Hyderabad Warehouse 1 (placeholder)', 'Hyderabad'],
  ],
  departments: ['Operations', 'Logistics', 'Finance', 'Admin', 'IT', 'Sales'],
  paymentModes: ['Cash', 'UPI', 'Bank Transfer', 'Company Card', 'Cheque', 'Petty Cash'],
};

/* =====================================================================
 * Web app entry points
 * ===================================================================== */

/** Serves the frontend. Google has already checked the visitor is a stownest.com user. */
function doGet() {
  let page;
  try {
    page = HtmlService.createTemplateFromFile('Index').evaluate();
  } catch (e) {
    page = HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Backend is running. ' +
      'The frontend (Index.html) has not been added yet.</p>');
  }
  return page
    .setTitle(CONFIG.APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1'); // stops iPhone zooming into form fields
}

/** Used inside Index.html: <?!= include('Styles') ?> pastes another HTML file in. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * The single function the frontend calls: google.script.run.api({ action, token, ... }).
 * Always returns { ok: true, data } or { ok: false, error, code } — never throws,
 * so the frontend handles every outcome in one place.
 */
function api(request) {
  try {
    const req = request || {};
    const action = String(req.action || '');
    if (action === 'login') return { ok: true, data: login_(req.passcode) };

    requireToken_(req.token);

    let data;
    switch (action) {
      case 'bootstrap':     data = { categories: getCategories_(), lists: getLists_() }; break;
      case 'getExpenses':   data = getExpenses_(); break;
      case 'addExpense':    data = addExpense_(req.payload); break;
      case 'updateExpense': data = updateExpense_(req.payload); break;
      case 'logout':        CacheService.getScriptCache().remove('tok_' + req.token); data = true; break;
      default: throw appError_('Unknown action: ' + action);
    }
    return { ok: true, data: data };
  } catch (err) {
    if (!err.isAppError) console.error(err && err.stack ? err.stack : err);
    return {
      ok: false,
      error: err.isAppError ? err.message : 'Server error. Please try again.',
      code: err.code || 'ERROR',
    };
  }
}

/* =====================================================================
 * Authentication (shared passcode -> short-lived session token)
 * ===================================================================== */

function login_(passcode) {
  const expected = PropertiesService.getScriptProperties().getProperty('APP_PASSCODE');
  if (!expected) throw appError_('Passcode is not configured on the server.', 'CONFIG');

  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('login_fails') || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAILS) {
    throw appError_('Too many failed attempts. Please try again in 10 minutes.', 'LOCKED');
  }

  if (!safeEqual_(String(passcode || ''), expected)) {
    cache.put('login_fails', String(fails + 1), 600);
    Utilities.sleep(800); // slows down guessing
    throw appError_('Incorrect passcode.', 'AUTH');
  }

  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put('tok_' + token, '1', CONFIG.TOKEN_TTL_SECONDS);
  return { token: token, expiresIn: CONFIG.TOKEN_TTL_SECONDS };
}

function requireToken_(token) {
  if (!token || !CacheService.getScriptCache().get('tok_' + token)) {
    throw appError_('Your session has expired. Please sign in again.', 'AUTH');
  }
}

/** Compares every character so response time doesn't leak how much matched. */
function safeEqual_(a, b) {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * setup() and runSelfTest() are public so they appear in the editor's Run menu,
 * which also means a signed-in visitor could call them via google.script.run.
 * This check allows only the script owner (the person running it from the editor).
 */
function assertOwner_() {
  const active = Session.getActiveUser().getEmail();
  const owner = Session.getEffectiveUser().getEmail();
  if (!active || active !== owner) throw new Error('Only the script owner can run this.');
}

/* =====================================================================
 * Reference data (Categories + Lists sheets)
 * ===================================================================== */

/** Returns [{ name, subcategories: [] }] for active rows, in sheet order. */
function getCategories_() {
  const sheet = getSheet_(CONFIG.SHEETS.CATEGORIES);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const rows = sheet.getRange(2, 1, last - 1, 3).getDisplayValues();

  const map = {};
  const order = [];
  rows.forEach(function (r) {
    const main = r[0].trim();
    const sub = r[1].trim();
    const active = r[2].trim().toUpperCase() !== 'N'; // blank counts as active
    if (!main || !active) return;
    if (!map[main]) { map[main] = []; order.push(main); }
    if (sub && map[main].indexOf(sub) === -1) map[main].push(sub);
  });
  return order.map(function (name) { return { name: name, subcategories: map[name] }; });
}

/**
 * Returns {
 *   cities: [], departments: [], paymentModes: [],
 *   warehouses: [{ name, city }]   // city '' = not linked to a city (allowed with any city)
 * }
 * Columns are found by header name, so their order in the sheet doesn't matter.
 */
function getLists_() {
  const result = { cities: [], warehouses: [], departments: [], paymentModes: [] };
  const sheet = getSheet_(CONFIG.SHEETS.LISTS);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return result;

  const values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  const headers = values[0].map(function (h) { return h.trim().toLowerCase(); });
  const col = function (name) { return headers.indexOf(name.toLowerCase()); };

  const simple = { cities: col('Cities'), departments: col('Departments'), paymentModes: col('Payment Modes') };
  const whCol = col('Warehouses');
  const whCityCol = col('Warehouse City');
  const seenWh = {};

  for (let r = 1; r < values.length; r++) {
    Object.keys(simple).forEach(function (key) {
      if (simple[key] === -1) return;
      const v = values[r][simple[key]].trim();
      if (v && result[key].indexOf(v) === -1) result[key].push(v);
    });
    if (whCol !== -1) {
      const name = values[r][whCol].trim();
      if (name && !seenWh[name]) {
        seenWh[name] = true;
        result.warehouses.push({ name: name, city: whCityCol === -1 ? '' : values[r][whCityCol].trim() });
      }
    }
  }
  return result;
}

/* =====================================================================
 * Expenses
 * ===================================================================== */

function getExpenses_() {
  const sheet = getSheet_(CONFIG.SHEETS.EXPENSES);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const rows = sheet.getRange(2, 1, last - 1, EXPENSE_HEADERS.length).getValues();
  return rows
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(rowToExpense_);
}

function addExpense_(payload) {
  if (!payload || typeof payload !== 'object') throw appError_('Missing expense data.');
  const clean = validateExpense_(payload, null);
  const file = payload.file ? validateFile_(payload.file) : null;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
    throw appError_('The server is busy. Please try again in a moment.', 'BUSY');
  }

  let savedFile = null;
  try {
    const id = nextExpenseId_();
    const now = new Date();

    if (file) savedFile = saveBill_(file, id);

    const record = Object.assign({}, clean, {
      id: id,
      billFileId: savedFile ? savedFile.id : '',
      billLink: savedFile ? savedFile.url : '',
      createdAt: now,
      updatedAt: now,
    });

    const sheet = getSheet_(CONFIG.SHEETS.EXPENSES);
    sheet.appendRow(expenseToRow_(record));
    SpreadsheetApp.flush();

    // Read the row back (we still hold the lock, so the last row is ours) so the
    // frontend gets exactly what the sheet stored, e.g. without the formula-guard apostrophe.
    const saved = sheet.getRange(sheet.getLastRow(), 1, 1, EXPENSE_HEADERS.length).getValues()[0];
    return rowToExpense_(saved);
  } catch (err) {
    if (savedFile) trashQuietly_(savedFile.id); // don't leave orphan files
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function updateExpense_(payload) {
  if (!payload || !payload.id) throw appError_('Expense ID is required for an update.');
  const file = payload.file ? validateFile_(payload.file) : null;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
    throw appError_('The server is busy. Please try again in a moment.', 'BUSY');
  }

  let savedFile = null;
  try {
    const sheet = getSheet_(CONFIG.SHEETS.EXPENSES);
    const rowNum = findExpenseRow_(sheet, String(payload.id));
    if (!rowNum) throw appError_('Expense ' + payload.id + ' was not found.', 'NOT_FOUND');

    const range = sheet.getRange(rowNum, 1, 1, EXPENSE_HEADERS.length);
    const existing = rowToExpense_(range.getValues()[0]);

    // Optimistic concurrency: reject if someone else saved after this user loaded it.
    if (payload.updatedAt && payload.updatedAt !== existing.updatedAt) {
      throw appError_('This expense was changed by someone else. Reload and try again.', 'CONFLICT');
    }

    const clean = validateExpense_(payload, existing);
    if (file) savedFile = saveBill_(file, existing.id);

    const record = Object.assign({}, clean, {
      id: existing.id,
      billFileId: savedFile ? savedFile.id : existing.billFileId,
      billLink: savedFile ? savedFile.url : existing.billLink,
      createdAt: parseTimestamp_(existing.createdAt) || existing.createdAt,
      updatedAt: new Date(),
    });

    range.setValues([expenseToRow_(record)]);
    SpreadsheetApp.flush();
    return rowToExpense_(range.getValues()[0]);
  } catch (err) {
    if (savedFile) trashQuietly_(savedFile.id);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Validates and normalises an incoming expense.
 * `existing` is the stored record on update: a category or list value that was
 * later deactivated/removed in the sheet is still accepted if it is unchanged,
 * so old expenses stay editable.
 */
function validateExpense_(p, existing) {
  const errors = [];
  const categories = getCategories_();
  const lists = getLists_();

  const str = function (v) { return v === undefined || v === null ? '' : String(v).trim(); };
  const keep = function (field, value) { return !!existing && existing[field] === value; };

  const out = {
    date: str(p.date),
    mainCategory: str(p.mainCategory),
    subcategory: str(p.subcategory),
    city: str(p.city),
    warehouse: str(p.warehouse),
    department: str(p.department),
    description: str(p.description),
    amount: Number(p.amount),
    vendor: str(p.vendor),
    paymentMode: str(p.paymentMode),
    invoiceNumber: str(p.invoiceNumber),
    remarks: str(p.remarks),
  };

  // Date: yyyy-MM-dd and a real calendar date
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(out.date);
  if (!dm) {
    errors.push('Expense date is required (YYYY-MM-DD).');
  } else {
    const y = +dm[1], m = +dm[2], d = +dm[3];
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d || y < 2000 || y > 2100) {
      errors.push('Expense date is not a valid date.');
    }
  }

  // Category / subcategory
  const cat = categories.filter(function (c) { return c.name === out.mainCategory; })[0];
  if (!out.mainCategory) {
    errors.push('Main category is required.');
  } else if (!cat && !keep('mainCategory', out.mainCategory)) {
    errors.push('Main category "' + out.mainCategory + '" is not an active category.');
  } else if (cat) {
    if (cat.subcategories.length) {
      if (!out.subcategory) errors.push('Subcategory is required for ' + cat.name + '.');
      else if (cat.subcategories.indexOf(out.subcategory) === -1 && !keep('subcategory', out.subcategory)) {
        errors.push('Subcategory "' + out.subcategory + '" does not belong to ' + cat.name + '.');
      }
    } else if (isOtherCategory_(cat.name)) {
      // "Other ..." categories: the user types their own expense name, stored as the subcategory
      if (!out.subcategory && !keep('subcategory', out.subcategory)) errors.push('Give this expense a name (e.g. Pooja items).');
      else if (out.subcategory.length > 100) errors.push('Expense name must be at most 100 characters.');
    } else if (out.subcategory && !keep('subcategory', out.subcategory)) {
      errors.push(cat.name + ' has no subcategories.');
    }
  }

  // Simple dropdown values must come from the Lists sheet
  [['city', 'cities', 'City'], ['department', 'departments', 'Department'],
   ['paymentMode', 'paymentModes', 'Payment mode']]
    .forEach(function (f) {
      const value = out[f[0]];
      if (!value) errors.push(f[2] + ' is required.');
      else if (lists[f[1]].indexOf(value) === -1 && !keep(f[0], value)) {
        errors.push(f[2] + ' "' + value + '" is not in the Lists sheet.');
      }
    });

  // Warehouse must exist and belong to the chosen city
  if (!out.warehouse) {
    errors.push('Warehouse is required.');
  } else {
    const wh = lists.warehouses.filter(function (w) { return w.name === out.warehouse; })[0];
    const unchanged = keep('warehouse', out.warehouse) && keep('city', out.city);
    if (!wh && !unchanged) {
      errors.push('Warehouse "' + out.warehouse + '" is not in the Lists sheet.');
    } else if (wh && wh.city && out.city && wh.city !== out.city && !unchanged) {
      errors.push('Warehouse "' + out.warehouse + '" is in ' + wh.city + ', not ' + out.city + '.');
    }
  }

  // Amount
  if (!isFinite(out.amount) || out.amount <= 0) errors.push('Amount must be greater than zero.');
  else if (out.amount > 1e9) errors.push('Amount is too large.');
  else out.amount = Math.round(out.amount * 100) / 100;

  // Text fields
  if (!out.description) errors.push('Description is required.');
  [['description', 500, 'Description'], ['vendor', 150, 'Vendor name'],
   ['invoiceNumber', 100, 'Invoice number'], ['remarks', 1000, 'Remarks']]
    .forEach(function (f) {
      if (out[f[0]].length > f[1]) errors.push(f[2] + ' must be at most ' + f[1] + ' characters.');
    });

  if (errors.length) throw appError_(errors.join(' '), 'VALIDATION');
  return out;
}

/** A category whose name starts with "Other" lets users type their own expense name. */
function isOtherCategory_(name) {
  return /^other/i.test(String(name || ''));
}

/* =====================================================================
 * Bills (Google Drive)
 * ===================================================================== */

/** file = { name, mimeType, base64 } -> { name, mimeType, bytes } */
function validateFile_(file) {
  if (!file.base64 || !file.mimeType) throw appError_('Bill upload is incomplete.', 'VALIDATION');
  const ext = CONFIG.ALLOWED_MIME[file.mimeType];
  if (!ext) throw appError_('Only PDF, JPG and PNG files are allowed.', 'VALIDATION');

  let bytes;
  try { bytes = Utilities.base64Decode(String(file.base64)); }
  catch (e) { throw appError_('Bill file could not be read.', 'VALIDATION'); }

  if (bytes.length === 0) throw appError_('Bill file is empty.', 'VALIDATION');
  if (bytes.length > CONFIG.MAX_FILE_BYTES) {
    throw appError_('Bill file must be ' + (CONFIG.MAX_FILE_BYTES / 1048576) + ' MB or smaller.', 'VALIDATION');
  }

  // Check the file's real signature, not just the declared type
  const b = function (i) { return bytes[i] & 0xff; };
  const okSig =
    (ext === 'pdf' && b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) ||  // %PDF
    (ext === 'png' && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) ||  // .PNG
    (ext === 'jpg' && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff);                      // JPEG
  if (!okSig) throw appError_('The file content does not match its type (PDF/JPG/PNG).', 'VALIDATION');

  const base = String(file.name || 'bill').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').slice(0, 60) || 'bill';
  return { name: base + '.' + ext, mimeType: file.mimeType, bytes: bytes };
}

function saveBill_(file, expenseId) {
  const folder = getBillsFolder_();
  const blob = Utilities.newBlob(file.bytes, file.mimeType, expenseId + '_' + file.name);
  const driveFile = folder.createFile(blob);

  // Only signed-in stownest.com users with the link can view.
  try {
    driveFile.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    console.warn('Domain sharing not available, file kept private: ' + e);
  }
  return { id: driveFile.getId(), url: driveFile.getUrl() };
}

function getBillsFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty('BILLS_FOLDER_ID');
  if (!id) throw appError_('Bills folder is not configured. Run setup() first.', 'CONFIG');
  return DriveApp.getFolderById(id);
}

function trashQuietly_(fileId) {
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { console.warn(e); }
}

/* =====================================================================
 * Row <-> object helpers
 * ===================================================================== */

/** Must be called while holding the script lock. */
function nextExpenseId_() {
  const props = PropertiesService.getScriptProperties();
  let seq = Number(props.getProperty('LAST_EXPENSE_SEQ'));

  if (!seq) {
    // First run (or property lost): continue from the highest ID in the sheet.
    seq = 0;
    getExpenses_().forEach(function (e) {
      const n = Number(String(e.id).replace(CONFIG.ID_PREFIX, ''));
      if (n > seq) seq = n;
    });
  }
  seq += 1;
  props.setProperty('LAST_EXPENSE_SEQ', String(seq));
  return CONFIG.ID_PREFIX + String(seq).padStart(CONFIG.ID_PAD, '0');
}

function findExpenseRow_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const cell = sheet.getRange(2, 1, last - 1, 1)
    .createTextFinder(id).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

function expenseToRow_(rec) {
  return EXPENSE_KEYS.map(function (k) {
    const v = rec[k];
    if (k === 'date') return toSheetDate_(v);
    if (k === 'amount') return Number(v);
    if (v instanceof Date) return v;
    return sanitizeCell_(v === undefined || v === null ? '' : String(v));
  });
}

function rowToExpense_(row) {
  const tz = Session.getScriptTimeZone();
  const obj = {};
  EXPENSE_KEYS.forEach(function (k, i) {
    let v = row[i];
    if (k === 'date') v = v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v || '');
    else if (k === 'createdAt' || k === 'updatedAt') {
      v = v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss') : String(v || '');
    } else if (k === 'amount') v = Number(v) || 0;
    else v = v === null || v === undefined ? '' : String(v);
    obj[k] = v;
  });
  return obj;
}

/** 'yyyy-MM-dd' -> Date at midnight in the script time zone */
function toSheetDate_(s) {
  if (s instanceof Date) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : s;
}

function parseTimestamp_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** Stops user text like "=IMPORTXML(...)" from running as a formula. */
function sanitizeCell_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function getSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw appError_('Sheet "' + name + '" is missing. Run setup().', 'CONFIG');
  return sheet;
}

function appError_(message, code) {
  const e = new Error(message);
  e.isAppError = true;
  e.code = code || 'ERROR';
  return e;
}

/* =====================================================================
 * One-time setup — run from the Apps Script editor
 * Safe to re-run: it never overwrites existing data.
 * ===================================================================== */

function setup() {
  assertOwner_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());

  // --- Expenses
  const exp = ensureSheet_(ss, CONFIG.SHEETS.EXPENSES, EXPENSE_HEADERS);
  exp.getRange('B:B').setNumberFormat('yyyy-mm-dd');
  exp.getRange('I:I').setNumberFormat('#,##0.00');
  exp.getRange('P:Q').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  exp.getRange('A1:Q1').setNumberFormat('@'); // keep header row as text

  // --- Categories
  const cat = ensureSheet_(ss, CONFIG.SHEETS.CATEGORIES, ['Main Category', 'Subcategory', 'Active (Y/N)']);
  if (cat.getLastRow() < 2) {
    const rows = [];
    DEFAULT_CATEGORIES.forEach(function (c) {
      if (c[1].length) c[1].forEach(function (s) { rows.push([c[0], s, 'Y']); });
      else rows.push([c[0], '', 'Y']);
    });
    cat.getRange(2, 1, rows.length, 3).setValues(rows);
  }

  // --- Lists
  const lists = ensureSheet_(ss, CONFIG.SHEETS.LISTS, LIST_HEADERS);
  if (lists.getLastRow() < 2) {
    const d = DEFAULT_LISTS;
    const maxLen = Math.max(d.cities.length, d.warehouses.length, d.departments.length, d.paymentModes.length);
    const rows = [];
    for (let i = 0; i < maxLen; i++) {
      const wh = d.warehouses[i] || ['', ''];
      rows.push([d.cities[i] || '', wh[0], wh[1], d.departments[i] || '', d.paymentModes[i] || '']);
    }
    lists.getRange(2, 1, rows.length, LIST_HEADERS.length).setValues(rows);
  } else {
    addWarehouseCityColumn_(lists); // upgrade a Lists sheet made by the earlier version
  }

  // Remove the default empty "Sheet1"
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  // --- Drive folder for bills (private by default)
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BILLS_FOLDER_ID')) {
    const folder = DriveApp.createFolder(CONFIG.BILLS_FOLDER_NAME);
    props.setProperty('BILLS_FOLDER_ID', folder.getId());
    console.log('Created Drive folder: ' + folder.getUrl());
  }

  if (!props.getProperty('APP_PASSCODE')) {
    console.warn('APP_PASSCODE is not set. Add it under Project Settings > Script Properties.');
  }
  console.log('Setup complete.');
}

/** Inserts a "Warehouse City" column right after "Warehouses" if it is missing. */
function addWarehouseCityColumn_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .map(function (h) { return h.trim().toLowerCase(); });
  if (headers.indexOf('warehouse city') !== -1) return;
  const whIdx = headers.indexOf('warehouses');
  if (whIdx === -1) return;
  sheet.insertColumnAfter(whIdx + 1);
  sheet.getRange(1, whIdx + 2).setValue('Warehouse City')
    .setFontWeight('bold').setBackground('#0f2a4a').setFontColor('#ffffff');
  console.warn('Added a "Warehouse City" column to Lists. Fill in the city for each warehouse.');
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#0f2a4a').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* =====================================================================
 * Self-test — run from the editor after setup() to verify the backend.
 * Adds a test expense with a tiny PDF, updates it, reads it back,
 * then deletes the test row and trashes the test file.
 * ===================================================================== */

function runSelfTest() {
  assertOwner_();
  const log = function (msg) { console.log('✔ ' + msg); };
  const cats = getCategories_();
  const lists = getLists_();
  if (!cats.length) throw new Error('No active categories found.');
  ['cities', 'warehouses', 'departments', 'paymentModes'].forEach(function (k) {
    if (!lists[k].length) throw new Error('List "' + k + '" is empty.');
  });
  log(cats.length + ' categories and all lists loaded');

  const c = cats[0];
  const wh = lists.warehouses[0];
  const city = wh.city || lists.cities[0];
  const pdf = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
  const added = addExpense_({
    date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    mainCategory: c.name, subcategory: c.subcategories[0] || '',
    city: city, warehouse: wh.name, department: lists.departments[0],
    paymentMode: lists.paymentModes[0], description: 'SELF TEST — safe to delete',
    amount: 123.456, vendor: '=HYPERLINK("x")', invoiceNumber: 'TEST-1',
    file: { name: 'test.pdf', mimeType: 'application/pdf', base64: Utilities.base64Encode(pdf) },
  });
  if (added.amount !== 123.46) throw new Error('Amount rounding failed: ' + added.amount);
  if (!added.billFileId) throw new Error('Bill was not uploaded.');
  log('Added ' + added.id + ' with bill ' + added.billLink);

  const updated = updateExpense_(Object.assign({}, added, { amount: 999, remarks: 'updated', file: null }));
  if (updated.amount !== 999 || updated.remarks !== 'updated') throw new Error('Update failed.');
  if (updated.createdAt !== added.createdAt) throw new Error('Created At changed on update.');
  log('Updated ' + updated.id);

  const found = getExpenses_().filter(function (e) { return e.id === added.id; })[0];
  if (!found || found.amount !== 999) throw new Error('Fetch did not return the updated row.');
  if (found.vendor !== '=HYPERLINK("x")') throw new Error('Formula sanitising changed the stored text.');
  log('Fetched ' + found.id + ' correctly');

  let rejected = false;
  try { addExpense_({ date: '2026-02-30', amount: -5 }); } catch (e) { rejected = e.code === 'VALIDATION'; }
  if (!rejected) throw new Error('Invalid data was not rejected.');
  log('Invalid data rejected');

  const otherCity = lists.cities.filter(function (x) { return wh.city && x !== wh.city; })[0];
  if (otherCity) {
    let wrongCity = false;
    try { addExpense_(Object.assign({}, added, { city: otherCity, file: null })); }
    catch (e) { wrongCity = e.code === 'VALIDATION' && e.message.indexOf('is in') !== -1; }
    if (!wrongCity) throw new Error('A warehouse from another city was accepted.');
    log('Warehouse from the wrong city rejected');
  }

  const sheet = getSheet_(CONFIG.SHEETS.EXPENSES);
  sheet.deleteRow(findExpenseRow_(sheet, added.id));
  trashQuietly_(added.billFileId);
  log('Cleaned up test row and file. ALL TESTS PASSED.');
}

/* =====================================================================
 * One-time: replaces everything in the Categories tab with DEFAULT_CATEGORIES.
 * Run it from the editor only. Old expenses keep their old category text.
 * ===================================================================== */
function replaceCategories() {
  assertOwner_();
  const sheet = getSheet_(CONFIG.SHEETS.CATEGORIES);
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, 3).clearContent();

  const rows = [];
  DEFAULT_CATEGORIES.forEach(function (c) {
    if (c[1].length) c[1].forEach(function (s) { rows.push([c[0], s, 'Y']); });
    else rows.push([c[0], '', 'Y']);
  });
  sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  console.log('Categories replaced: ' + rows.length + ' rows.');
}
