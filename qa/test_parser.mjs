#!/usr/bin/env node
/* Self-contained parser test harness.
   Copy-pastes parser logic from app.js (kept in sync manually)
   and runs it against fixtures, comparing to golden expected JSON.

   Usage:  node qa/test_parser.mjs
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

// =========================================================
// Parser logic — kept in sync with app.js's parseDocument family.
// =========================================================
const QTY_UNIT_RE = /\b(\d+(\.\d+)?)\s?(lb|lbs|kg|g|gm|gms|oz|ml|l|lt|ltr|gal|ct|pk|pack|each|ea|count|cnt)\b/gi;

function parseDocument(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const joined = lines.join('\n');
  const STRONG_STATEMENT = /\b(statement period|account statement|narration|withdrawal\s+deposit|opening\s+balance|closing\s+balance|cardholder|posting\s+date|chq\/?ref)\b/i;
  const STRONG_RECEIPT   = /\b(subtotal|sub\s*total|sales\s*tax|tendered|cash\s*tend|gst|cgst|sgst|change\s+due)\b/i;
  if (STRONG_STATEMENT.test(joined)) return parseStatement(lines);
  if (STRONG_RECEIPT.test(joined))   return parseReceipt(lines);
  const dateAmtLines = lines.filter(l => /\d{1,2}[\/\-]\d{1,2}/.test(l) && /\d[\d,]*\.\d{2}\s*$/.test(l));
  if (dateAmtLines.length >= 5) return parseStatement(lines);
  return parseReceipt(lines);
}

function parseReceipt(lines) {
  const store = guessStore(lines);
  const date = guessDate(lines);
  const currency = guessCurrency(lines);
  const total = guessTotal(lines);
  const lineItems = [];

  const SKIP_TOKENS = /^(sub\s*total|total|tax|gst|cgst|sgst|vat|change|cash|tender|debit|credit|balance|amount|round|tip|gratuity|service|visa|master|amex|discover|paid|payment|acct|account|approval|auth(orization)?|ref|aid|tip|due|saved|savings|loyalty)/i;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length < 4) continue;
    if (SKIP_TOKENS.test(line)) continue;

    const priceMatch = line.match(/(-?\d[\d,]*\.\d{2})\s*[A-Z]?\s*$/);
    if (!priceMatch) continue;
    const price = parseFloat(priceMatch[1].replace(/,/g, ''));
    if (isNaN(price) || price <= 0) continue;
    let head = line.slice(0, priceMatch.index).trim();
    head = head.replace(/\s+[A-Z]\s*$/,'').trim();

    let qty = 1, unitPrice = price;
    // Allow optional unit between qty and @, e.g. "2.13 lb @ 0.58 /lb"
    const qtyAt = head.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|kg|g|gm|oz|ml|l|lt|ltr|gal|ct|pk|each|ea|count|cnt)?\s*(?:@|x|×)\s*(\d+(?:\.\d+)?)/i);
    if (qtyAt) {
      qty = parseFloat(qtyAt[1]);
      unitPrice = parseFloat(qtyAt[2]);
      head = head.replace(qtyAt[0], '').trim();
    }

    // Strip long digit codes (SKUs) anywhere in the head
    head = head.replace(/\b\d{8,}\b/g, ' ');
    // Strip per-unit suffix like "/lb", "/kg"
    head = head.replace(/\/[a-z]+/gi, ' ');
    // Collapse whitespace
    head = head.replace(/\s+/g, ' ').trim();
    head = head.replace(/^\d{4,}\s+/, '').trim();
    head = head.replace(/^[A-Z]\s+/, '').trim();
    if (head.length < 2) continue;

    lineItems.push({ name: head, qty, unitPrice, lineTotal: price });
  }

  return { docType: 'receipt', store, date, currency, total, lineItems };
}

function parseStatement(lines) {
  const issuer = guessStore(lines) || 'Bank statement';
  const currency = guessCurrency(lines);
  const date = guessDate(lines);
  const lineItems = [];
  const dateRe = /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{1,2}\s[A-Z][a-z]{2})/;
  const amtRe = /(-?\d[\d,]*\.\d{2})\s*(?:(Dr|Cr|CR|DR))?\s*$/;

  let total = 0;
  for (const raw of lines) {
    const line = raw.trim();
    const dateMatch = line.match(dateRe);
    const amtMatch = line.match(amtRe);
    if (!dateMatch || !amtMatch) continue;
    const txDate = parseLooseDate(dateMatch[1]);
    const amount = parseFloat(amtMatch[1].replace(/,/g, ''));
    if (isNaN(amount)) continue;
    const drcr = amtMatch[2];
    if (drcr && /CR/i.test(drcr)) continue;
    let merchant = line.slice(dateMatch.index + dateMatch[0].length, amtMatch.index).trim();
    merchant = merchant.replace(/^[\s|·]+|[\s|·]+$/g, '');
    merchant = merchant.replace(/\s{2,}/g, ' ');
    if (merchant.length < 2) continue;
    lineItems.push({ name: merchant, qty: 1, unitPrice: amount, lineTotal: amount, date: txDate });
    total += amount;
  }
  return { docType: 'statement', store: issuer, date, currency, total, lineItems };
}

function parseLooseDate(s) {
  const today = new Date();
  if (!s) return today.toISOString().slice(0,10);
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const [, a, b, c] = m;
    const yr = c ? (c.length === 2 ? 2000 + parseInt(c,10) : parseInt(c,10)) : today.getFullYear();
    const first = parseInt(a,10), second = parseInt(b,10);
    let mo, day;
    if (first > 12) { day = first; mo = second; }
    else if (second > 12) { mo = first; day = second; }
    else { mo = first; day = second; }
    return new Date(Date.UTC(yr, mo-1, day)).toISOString().slice(0,10);
  }
  m = s.match(/^(\d{1,2})\s([A-Z][a-z]{2})$/);
  if (m) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mo = months.indexOf(m[2].toLowerCase());
    if (mo >= 0) return new Date(Date.UTC(today.getFullYear(), mo, parseInt(m[1],10))).toISOString().slice(0,10);
  }
  return today.toISOString().slice(0,10);
}

function guessStore(lines) {
  const KNOWN = ['walmart','costco','target','kroger','safeway','whole foods','trader','aldi','heb','dmart','reliance','big bazaar','spencer','amazon','flipkart','starbucks','mcdonalds','swiggy','zomato','shell','bp','chevron','indian oil','iocl','hpcl','bpcl','chase','hdfc','sbi','icici','axis','citi','bank of america','wells fargo'];
  const upper = lines.slice(0, 10).join(' ').toLowerCase();
  for (const k of KNOWN) if (upper.includes(k)) return capitalize(k);
  for (const l of lines.slice(0, 6)) {
    if (l.length >= 3 && l.length <= 30 && l === l.toUpperCase() && /[A-Z]/.test(l)) return capitalize(l.toLowerCase());
  }
  return lines[0] ? lines[0].slice(0, 32) : 'Unknown';
}
function capitalize(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }

function guessCurrency(lines) {
  const j = lines.join(' ');
  if (/₹|\bRs\.?|\bINR\b/.test(j)) return 'INR';
  if (/\$|\bUSD\b/.test(j)) return 'USD';
  if (/€|\bEUR\b/.test(j)) return 'EUR';
  if (/£|\bGBP\b/.test(j)) return 'GBP';
  return 'USD';
}

function guessTotal(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^(grand\s*total|total\s*amount|total\s*due|total)\b/i.test(l) && !/sub/i.test(l)) {
      const m = l.match(/(\d[\d,]*\.\d{2})/);
      if (m) return parseFloat(m[1].replace(/,/g,''));
    }
  }
  return null;
}

function guessDate(lines) {
  for (const l of lines.slice(0, 30).concat(lines.slice(-10))) {
    const m = l.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/) || l.match(/(\d{1,2}\s[A-Z][a-z]{2}\s\d{2,4})/);
    if (m) return parseLooseDate(m[1]);
  }
  return null;
}

// =========================================================
// Test runner
// =========================================================
let pass = 0, fail = 0;
const fails = [];

function check(label, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push({ label, detail }); }
}

function near(a, b, eps = 0.01) { return a != null && b != null && Math.abs(a - b) < eps; }

// ------------- Walmart receipt vs golden -------------
{
  const text = fs.readFileSync(path.join(FIXTURES, 'receipt_walmart.txt'), 'utf8');
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected_parsed_walmart.json'), 'utf8'));
  const got = parseDocument(text);

  check('walmart: store identified', got.store === 'Walmart', `got "${got.store}"`);
  check('walmart: currency USD', got.currency === 'USD', `got "${got.currency}"`);
  check('walmart: total ≈ 100.66', near(got.total, expected.total), `got ${got.total}`);
  check('walmart: date 2026-04-12', got.date === expected.date, `got "${got.date}"`);
  check('walmart: 18 line items', got.lineItems.length === expected.lineItems.length,
    `got ${got.lineItems.length}: ${got.lineItems.map(li => li.name).join(' | ')}`);

  // Sample row checks
  const bananas = got.lineItems.find(li => /banana/i.test(li.name));
  check('walmart: BANANAS qty=2.13', bananas && near(bananas.qty, 2.13), bananas ? `qty=${bananas.qty}` : 'not found');
  check('walmart: BANANAS unit=0.58', bananas && near(bananas.unitPrice, 0.58), bananas ? `unit=${bananas.unitPrice}` : 'not found');
  check('walmart: BANANAS line=1.24', bananas && near(bananas.lineTotal, 1.24), bananas ? `total=${bananas.lineTotal}` : 'not found');

  const milk = got.lineItems.find(li => /milk/i.test(li.name));
  check('walmart: MILK name has no SKU digits', milk && !/\d{8,}/.test(milk.name), milk ? `name="${milk.name}"` : 'not found');

  const sumLines = got.lineItems.reduce((s, li) => s + (li.lineTotal || 0), 0);
  check('walmart: line totals reconcile to subtotal ±0.02', near(sumLines, expected.subtotal, 0.02),
    `sum=${sumLines.toFixed(2)} expected ${expected.subtotal}`);
}

// ------------- Costco receipt -------------
{
  const text = fs.readFileSync(path.join(FIXTURES, 'receipt_costco.txt'), 'utf8');
  const got = parseDocument(text);
  check('costco: store identified', got.store === 'Costco', `got "${got.store}"`);
  check('costco: at least 8 items parsed', got.lineItems.length >= 8, `got ${got.lineItems.length}`);
}

// ------------- Indian grocery -------------
{
  const text = fs.readFileSync(path.join(FIXTURES, 'receipt_indian_grocery.txt'), 'utf8');
  const got = parseDocument(text);
  check('indian: currency INR', got.currency === 'INR', `got "${got.currency}"`);
  check('indian: at least 8 items parsed', got.lineItems.length >= 8, `got ${got.lineItems.length}`);
}

// ------------- Amazon order -------------
{
  const text = fs.readFileSync(path.join(FIXTURES, 'receipt_amazon_order.txt'), 'utf8');
  const got = parseDocument(text);
  check('amazon: at least 4 items parsed', got.lineItems.length >= 4, `got ${got.lineItems.length}: ${got.lineItems.map(li => li.name).join(' | ')}`);
}

// ------------- Chase bank statement -------------
{
  const text = fs.readFileSync(path.join(FIXTURES, 'bank_statement_chase.txt'), 'utf8');
  const got = parseDocument(text);
  check('chase: detected as statement', got.docType === 'statement', `got "${got.docType}"`);
  check('chase: at least 15 transactions parsed', got.lineItems.length >= 15, `got ${got.lineItems.length}`);
}

// ------------- HDFC bank statement -------------
{
  const text = fs.readFileSync(path.join(FIXTURES, 'bank_statement_hdfc.txt'), 'utf8');
  const got = parseDocument(text);
  check('hdfc: detected as statement', got.docType === 'statement', `got "${got.docType}"`);
  check('hdfc: at least 12 debit transactions parsed', got.lineItems.length >= 12, `got ${got.lineItems.length}`);
  check('hdfc: currency INR', got.currency === 'INR', `got "${got.currency}"`);
}

// ------------- Output -------------
console.log(`\nResults:  ${pass} pass / ${fail} fail`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  ✗ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✓ all parser checks pass');
