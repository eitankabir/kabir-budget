require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '179hvX4lKWH28gWN87oPKaGzTgRprqqW8ovnW3Wn0-CU';
const SHEET_EXP = 'הוצאות';
const SHEET_INC = 'הכנסות';
const PASSWORD  = process.env.EDIT_PASSWORD || 'kabir123';
const PORT      = parseInt(process.env.PORT || '3000');
const KEY_FILE  = path.join(__dirname, process.env.GOOGLE_CREDENTIALS_FILE || 'kabir-family-budget-7fa4c3eb7a60.json');

let expSheetIdCache = null;

async function getClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getExpSheetId(client) {
  if (expSheetIdCache !== null) return expSheetIdCache;
  const meta = await client.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_EXP);
  expSheetIdCache = sheet?.properties.sheetId ?? null;
  return expSheetIdCache;
}

async function initSheets() {
  try {
    const client = await getClient();

    // Create missing tabs
    const meta = await client.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existing = new Set(meta.data.sheets.map(s => s.properties.title));
    const missing  = [SHEET_EXP, SHEET_INC].filter(t => !existing.has(t));
    if (missing.length) {
      await client.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) },
      });
      console.log('✅ Created tabs:', missing.join(', '));
    }

    // Refresh cache after possible tab creation
    expSheetIdCache = null;
    await getExpSheetId(client);

    // Init expense headers (only if row 1 is empty)
    const expR1 = await client.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_EXP}!A1`,
    });
    if (!expR1.data.values?.[0]?.[0]) {
      await client.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_EXP}!A1:H1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['תאריך','תיאור','סכום_משוער','סכום_סופי','מוציא','קטגוריה','סטטוס','הערות']] },
      });
      console.log('✅ Expenses headers set');
    }

    // Init income headers + opening balances (only if row 1 is empty)
    const incR1 = await client.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_INC}!A1`,
    });
    if (!incR1.data.values?.[0]?.[0]) {
      await client.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_INC}!A1:D5`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [
          ['תאריך', 'שם', 'סכום', 'הערה'],
          ['15/04/2026', 'עתידה', 5000, 'העברה בנקאית'],
          ['15/04/2026', 'שלומי', 5000, 'העברה בנקאית'],
          ['15/04/2026', 'הראל',  5000, 'העברה בנקאית'],
          ['19/04/2026', 'איתן',  5000, 'העברה בנקאית'],
        ]},
      });
      console.log('✅ Income headers + opening balances set');
    }
  } catch (err) {
    console.error('⚠️  Sheet init error:', err.message);
  }
}

// ── Auth ────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  req.body.password === PASSWORD
    ? res.json({ ok: true })
    : res.status(401).json({ error: 'סיסמה שגויה' });
});

// ── GET all data ────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const client = await getClient();
    const [expRes, incRes] = await Promise.all([
      client.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_EXP}!A2:H` }),
      client.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_INC}!A2:D` }),
    ]);

    const expenses = (expRes.data.values || []).filter(r => r[0]).map((r, i) => ({
      rowIndex:     i + 2,
      date:         r[0] || '',
      description:  r[1] || '',
      estimatedAmt: parseFloat(r[2]) || 0,
      finalAmt:     parseFloat(r[3]) || 0,
      spender:      r[4] || '',
      category:     r[5] || 'שונות/אחר',
      status:       r[6] || 'מתוכנן',
      notes:        r[7] || '',
    }));

    const income = (incRes.data.values || []).filter(r => r[0] && r[2]).map((r, i) => ({
      rowIndex: i + 2,
      date:     r[0] || '',
      name:     r[1] || '',
      amount:   parseFloat(r[2]) || 0,
      note:     r[3] || '',
    }));

    res.json({ expenses, income });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'שגיאה בטעינת הנתונים' });
  }
});

// ── POST expense ────────────────────────────────────────────
app.post('/api/expenses', async (req, res) => {
  const { password, date, description, estimatedAmt, finalAmt, spender, category, status, notes } = req.body;
  if (password !== PASSWORD) return res.status(401).json({ error: 'סיסמה שגויה' });
  if (!date || !description || !category || !status) return res.status(400).json({ error: 'יש למלא שדות חובה' });
  try {
    const client = await getClient();
    await client.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_EXP}!A:H`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        date, description,
        String(estimatedAmt || 0), String(finalAmt || 0),
        spender || '', category, status, notes || '',
      ]]},
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'שגיאה בשמירה' });
  }
});

// ── PUT expense (edit) ──────────────────────────────────────
app.put('/api/expenses', async (req, res) => {
  const { password, rowIndex, date, description, estimatedAmt, finalAmt, spender, category, status, notes } = req.body;
  if (password !== PASSWORD) return res.status(401).json({ error: 'סיסמה שגויה' });
  if (!rowIndex || rowIndex < 2) return res.status(400).json({ error: 'שורה לא תקינה' });
  try {
    const client = await getClient();
    await client.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_EXP}!A${rowIndex}:H${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        date, description,
        String(estimatedAmt || 0), String(finalAmt || 0),
        spender || '', category, status, notes || '',
      ]]},
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'שגיאה בעדכון' });
  }
});

// ── DELETE expense ──────────────────────────────────────────
app.delete('/api/expenses', async (req, res) => {
  const { password, rowIndex } = req.body;
  if (password !== PASSWORD) return res.status(401).json({ error: 'סיסמה שגויה' });
  if (!rowIndex || rowIndex < 2) return res.status(400).json({ error: 'שורה לא תקינה' });
  try {
    const client = await getClient();
    const sheetId = await getExpSheetId(client);
    await client.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
        },
      }]},
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'שגיאה במחיקה' });
  }
});

// ── PUT income (edit) ───────────────────────────────────────
app.put('/api/income', async (req, res) => {
  const { password, rowIndex, date, name, amount, note } = req.body;
  if (password !== PASSWORD) return res.status(401).json({ error: 'סיסמה שגויה' });
  if (!rowIndex || rowIndex < 2) return res.status(400).json({ error: 'שורה לא תקינה' });
  try {
    const client = await getClient();
    await client.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_INC}!A${rowIndex}:D${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[date, name, String(amount), note || '']] },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'שגיאה בעדכון' });
  }
});

// ── POST income ─────────────────────────────────────────────
app.post('/api/income', async (req, res) => {
  const { password, date, name, amount, note } = req.body;
  if (password !== PASSWORD) return res.status(401).json({ error: 'סיסמה שגויה' });
  if (!date || !name || !amount) return res.status(400).json({ error: 'יש למלא שדות חובה' });
  try {
    const client = await getClient();
    await client.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_INC}!A:D`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[date, name, String(amount), note || '']] },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'שגיאה בשמירה' });
  }
});

app.listen(PORT, async () => {
  console.log(`\n🏠  תקציב משפחת כביר`);
  console.log(`✅  שרת פועל ב-http://localhost:${PORT}`);
  console.log(`📋  ${SPREADSHEET_ID}\n`);
  await initSheets();
});
