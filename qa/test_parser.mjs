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
  const STRONG_STATEMENT = /\b(statement period|account statement|narration|withdrawal\s+deposit|opening\s+balance|closing\s+balance|cardholder|posting\s+date|chq\/?ref|card\s+ending|payment\s+due\s+date|new\s+balance|closing\s+date|new\s+charges|american\s+express|card\s+member|previous\s+balance|minimum\s+payment\s+due)\b/i;
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
  const issuer = guessStore(lines) || 'Statement';
  const currency = guessCurrency(lines);
  const date = guessDate(lines);
  const lineItems = [];

  const dateLineRe   = /^(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{1,2}\s[A-Z][a-z]{2})\*?\s*(.*)$/;
  const inlineAmtRe  = /(-?\$?\s*-?\$?\d[\d,]*\.\d{2})\s*(?:(Dr|Cr|CR|DR))?\s*$/;
  const onlyAmtRe    = /^(-?\$?\s*-?\$?\d[\d,]*\.\d{2})\s*(?:(Dr|Cr|CR|DR))?\s*$/;
  const SECTION_HEAD = /^(Date\b|Description\b|Amount\b|Total\b|Category\b|Account\b|Card\s+Ending|Customer|Branch|Statement|Period|HEMANTH|MR\.|MS\.|MRS\.)/i;
  const SUMMARY_LABEL = /^\s*(new\s+balance|minimum\s+payment(\s+due)?|payment\s+due(\s+date)?|credit\s+limit|available\s+credit|available\s+cash|previous\s+balance|new\s+charges(\s+summary)?|total\s+(fees|interest|new\s+charges|payments?(\s+and\s+credits)?|interest\s+charged)|opening\s+balance|closing\s+balance|closing\s+date|amount\s+enclosed|reward\s+dollars|less\s+payments|equals\s+new\s+balance|plus\s+(new\s+charges|fees|interest\s+charged)|account\s+(summary|details|ending)|payment\s+summary|credit\s+summary|rewards\s+summary)\s*$/i;

  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dm = line.match(dateLineRe);
    if (!dm) continue;

    const txDate = parseLooseDate(dm[1]);
    let merchant = (dm[2] || '').trim();
    let amount = null;
    let drcr = null;
    let consumed = 1;

    const inline = merchant.match(inlineAmtRe);
    if (inline) {
      amount = parseAmount(inline[1]);
      drcr = inline[2];
      merchant = merchant.slice(0, inline.index).trim();
    } else {
      for (let j = 1; j <= 4 && i + j < lines.length; j++) {
        const next = lines[i + j];
        if (dateLineRe.test(next) && !/^Date\b/i.test(next)) break;
        if (SECTION_HEAD.test(next)) break;
        const am = next.match(onlyAmtRe);
        if (am) {
          amount = parseAmount(am[1]);
          drcr = am[2];
          consumed = j + 1;
          break;
        }
        if (next.length < 100) merchant += ' ' + next;
      }
    }

    if (amount == null || isNaN(amount)) continue;
    if (drcr && /CR/i.test(drcr)) { i += consumed - 1; continue; }
    if (amount <= 0) { i += consumed - 1; continue; }

    merchant = cleanMerchantName(merchant);
    if (merchant.length < 2) { i += consumed - 1; continue; }
    if (SUMMARY_LABEL.test(merchant)) { i += consumed - 1; continue; }
    if ((merchant.match(/[A-Za-z]/g) || []).length < 3) { i += consumed - 1; continue; }

    lineItems.push({ name: merchant, qty: 1, unitPrice: amount, lineTotal: amount, date: txDate });
    total += amount;
    i += consumed - 1;
  }
  return { docType: 'statement', store: issuer, date, currency, total, lineItems };
}

function parseAmount(s) {
  if (!s) return NaN;
  return parseFloat(s.replace(/[$\s]/g, '').replace(/,/g, ''));
}
function cleanMerchantName(s) {
  if (!s) return '';
  let out = s;
  out = out.replace(/\+\d{10,}/g, ' ');
  out = out.replace(/\b\d{10,}\b/g, ' ');
  out = out.replace(/\b\d{6,}\b/g, ' ');
  out = out.replace(/\/\s*\S+@\S+/g, ' ');
  out = out.replace(/[#*]/g, ' ');
  out = out.replace(/\s+\d{5}(-\d{4})?\b/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/^[\s|·\-]+|[\s|·\-]+$/g, '');
  return out;
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
  const KNOWN = [
    'american express','amex','chase','hdfc','sbi','icici','axis','citi','bank of america','wells fargo','capital one','discover','us bank','barclays','synchrony','goldman','apple card',
    'walmart','costco','target','kroger','safeway','whole foods','trader','aldi','heb','dmart','reliance','big bazaar','spencer','wegmans','publix',
    'amazon','flipkart','starbucks','mcdonalds','swiggy','zomato','doordash','grubhub',
    'shell','bp','chevron','exxon','indian oil','iocl','hpcl','bpcl',
  ];
  const upper = lines.slice(0, 20).join(' ').toLowerCase();
  for (const k of KNOWN) if (upper.includes(k)) return capitalize(k);
  const SKIP_HEAD = /^(prepared for|account|card|customer|page|statement|hemanth|mr\.|mrs\.|ms\.)/i;
  for (const l of lines.slice(0, 8)) {
    if (SKIP_HEAD.test(l)) continue;
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

// ------------- Amex January 2026 statement -------------
{
  const text = fs.readFileSync(path.join(FIXTURES, 'amex_jan_2026.txt'), 'utf8');
  const got = parseDocument(text);
  check('amex: detected as statement', got.docType === 'statement', `got "${got.docType}"`);
  check('amex: store identified as American Express', got.store === 'American Express', `got "${got.store}"`);
  check('amex: 3 line items (excludes payment + zero rows)', got.lineItems.length === 3, `got ${got.lineItems.length}: ${got.lineItems.map(li => li.name + ' $' + li.unitPrice).join(' | ')}`);
  const wholefoods = got.lineItems.find(li => /WHOLEFDS|Whole/i.test(li.name));
  check('amex: WHOLEFDS captured at $16.73', wholefoods && near(wholefoods.unitPrice, 16.73), wholefoods ? `$${wholefoods.unitPrice}` : 'not found');
  check('amex: WHOLEFDS name has no SKU/phone digits', wholefoods && !/\d{6,}/.test(wholefoods.name), wholefoods ? `name="${wholefoods.name}"` : 'not found');
  const openai = got.lineItems.find(li => /openai|chatgpt/i.test(li.name));
  check('amex: OPENAI captured at $21.78', openai && near(openai.unitPrice, 21.78), openai ? `$${openai.unitPrice}` : 'not found');
  check('amex: OPENAI name has no phone', openai && !/\+?\d{10,}/.test(openai.name), openai ? `name="${openai.name}"` : 'not found');
  const cinemark = got.lineItems.find(li => /cinemark/i.test(li.name));
  check('amex: CINEMARK captured at $13.64', cinemark && near(cinemark.unitPrice, 13.64), cinemark ? `$${cinemark.unitPrice}` : 'not found');
  check('amex: CINEMARK name has no email', cinemark && !/@/.test(cinemark.name), cinemark ? `name="${cinemark.name}"` : 'not found');
  check('amex: total reconciles to $52.15', near(got.lineItems.reduce((s,li) => s + li.lineTotal, 0), 52.15), `sum=${got.lineItems.reduce((s,li) => s + li.lineTotal, 0)}`);
  check('amex: no negative MOBILE PAYMENT included', !got.lineItems.some(li => /mobile payment/i.test(li.name)), got.lineItems.map(li => li.name).join(' | '));
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
