// Google Sheet access for the chat server. Only reads and appends: there is
// deliberately no delete function, so chat users can never remove a domain.
const { google } = require("googleapis");
const { checkDomain, getDomain } = require("./checker");

const ID = process.env.SHEET_ID;
const MAX_DOMAINS = Number(process.env.MAX_DOMAINS) || 200;
const enabled = () => Boolean(ID && process.env.GOOGLE_CREDENTIALS);

let client;
function api() {
  if (!client) {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    client = google.sheets({ version: "v4", auth });
  }
  return client;
}

// Tab name: use SHEET_TAB if set, otherwise the first tab of the spreadsheet.
let tabName;
async function tab() {
  if (tabName) return tabName;
  let name = process.env.SHEET_TAB;
  if (!name) {
    const meta = await api().spreadsheets.get({ spreadsheetId: ID, fields: "sheets.properties.title" });
    name = meta.data.sheets[0].properties.title;
  }
  return (tabName = `'${name.replace(/'/g, "''")}'`);
}

// 30-second cache keeps us well under Google's read quota.
let cache = { at: 0, rows: [] };
async function readRows(force = false) {
  if (!force && Date.now() - cache.at < 30000) return cache.rows;
  const res = await api().spreadsheets.values.get({ spreadsheetId: ID, range: `${await tab()}!A2:G` });
  cache = { at: Date.now(), rows: res.data.values || [] };
  return cache.rows;
}

const rowDomain = (r) => (r[1] || "").trim().toLowerCase() || getDomain(r[0] || "");
const findRow = (rows, domain) => rows.find((r) => rowDomain(r) === domain);

async function addDomain(domain) {
  const rows = await readRows(true);
  if (findRow(rows, domain)) return { added: false, reason: "it is already monitored" };
  if (rows.length >= MAX_DOMAINS) return { added: false, reason: "the list is full" };

  let check;
  try {
    check = await checkDomain(domain); // fails if no certificate can be read
  } catch (e) {
    e.isSite = true; // tells the server this is about the website, not the Sheet
    throw e;
  }
  const t = await tab();
  const res = await api().spreadsheets.values.append({
    spreadsheetId: ID,
    range: `${t}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[domain]] },
  });
  const row = Number(/(\d+)$/.exec(res.data.updates.updatedRange)[1]);
  const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  await api().spreadsheets.values.update({
    spreadsheetId: ID,
    range: `${t}!B${row}:G${row}`,
    valueInputOption: "RAW",
    requestBody: { values: [[domain, check.status, check.days, check.expires, check.issuer, now]] },
  });
  cache.at = 0;
  return { added: true, check };
}

// Re-check one already-monitored site and overwrite its row. Never deletes anything.
async function updateDomain(domain) {
  const rows = await readRows(true);
  const idx = rows.findIndex((r) => r[0] && rowDomain(r) === domain);
  if (idx === -1) return { updated: false };
  const row = idx + 2; // data starts on sheet row 2

  let result;
  try {
    result = await checkDomain(domain);
  } catch (e) {
    result = { status: "ERROR", error: e.message }; // same as the daily monitor records
  }
  const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const values = result.error
    ? [domain, `ERROR: ${result.error}`, "", "", "", now]
    : [domain, result.status, result.days, result.expires, result.issuer, now];
  await api().spreadsheets.values.update({
    spreadsheetId: ID,
    range: `${await tab()}!B${row}:G${row}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
  cache.at = 0;
  return { updated: true, result };
}

module.exports = { api, tab, enabled, readRows, findRow, rowDomain, addDomain, updateDomain };