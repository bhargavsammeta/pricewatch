/* =========================================================
   pricewatch — personal price tracker
   Local-only PWA. IndexedDB. No accounts, no servers.
   ========================================================= */

(() => {
  'use strict';

  // ============== Constants ==============
  const DB_NAME = 'pricewatch_db';
  const DB_VERSION = 1;

  const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

  const DEFAULT_CATEGORIES = [
    { id: 'groceries',     name: 'Groceries',     keywords: ['walmart','costco','kroger','safeway','target grocery','dmart','big bazaar','reliance fresh','more','spencer','grofers','blinkit','zepto','instamart','kirana','sprouts','trader','aldi','whole foods','heb'] },
    { id: 'dining',        name: 'Dining',        keywords: ['starbucks','mcdonalds','mcd','kfc','burger','dominos','pizza','swiggy','zomato','chipotle','panera','subway','dunkin','tims','five guys','chai','restaurant','cafe','cafe coffee','ccd','barista','taco'] },
    { id: 'transport',     name: 'Transport',     keywords: ['uber','lyft','ola','rapido','metro','transit','bart','caltrain','irctc','railway','bus'] },
    { id: 'fuel',          name: 'Fuel',          keywords: ['shell','bp','exxon','chevron','arco','indian oil','iocl','hpcl','bpcl','reliance petrol','petrol','gas station','76 station'] },
    { id: 'utilities',     name: 'Utilities',     keywords: ['electric','water','internet','xfinity','comcast','airtel','jio','vi ','vodafone','bsnl','tata power','mobile','recharge','at&t','verizon','t-mobile'] },
    { id: 'shopping',      name: 'Shopping',      keywords: ['amazon','amzn','flipkart','myntra','ajio','ebay','etsy','target','best buy','ikea','home depot','nykaa','lowes'] },
    { id: 'entertainment', name: 'Entertainment', keywords: ['movie','cinema','pvr','inox','amc','regal','steam','playstation','xbox','nintendo','ticketmaster','bookmyshow','game'] },
    { id: 'subscriptions', name: 'Subscriptions', keywords: ['netflix','spotify','prime','hotstar','disney','apple.com','icloud','google ','adobe','dropbox','linkedin','youtube premium','hbo','max'] },
    { id: 'health',        name: 'Health',        keywords: ['pharmacy','cvs','walgreens','apollo','medplus','doctor','clinic','hospital','medical','gym','fitness'] },
    { id: 'travel',        name: 'Travel',        keywords: ['airline','airways','indigo','spicejet','vistara','united','delta','airbnb','marriott','hilton','oyo','makemytrip','goibibo','expedia','booking'] },
    { id: 'other',         name: 'Other',         keywords: [] },
  ];

  const CATEGORY_BY_ID = Object.fromEntries(DEFAULT_CATEGORIES.map(c => [c.id, c]));

  const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
  const PDFJS_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';
  const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  // ============== State ==============
  const state = {
    settings: { currency: 'USD', theme: 'auto' },
    onboarded: false,
    activeTab: 'inbox',
    documents: [],
    transactions: [],
    lineItems: [],
    merchantRules: {},   // { 'WALMART #1234': 'groceries' }
    itemAliases: {},     // { 'coke 2l': 'coca-cola-2-l' }
    itemFilter: { search: '', category: 'all', store: 'all' },
    itemSort: 'recent',
    insightsPeriod: 30,
    activeReview: null,
  };

  let db;

  // ============== Tiny DOM helpers ==============
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    (Array.isArray(kids) ? kids : [kids]).forEach(k => {
      if (k == null || k === false) return;
      n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
    return n;
  };

  const uid = () => Math.random().toString(36).slice(2, 11) + Date.now().toString(36).slice(-4);

  // ============== Formatters ==============
  function fmtCurrency(v) {
    if (v == null || isNaN(v)) return '—';
    const sym = CURRENCY_SYMBOLS[state.settings.currency] || '';
    const n = Number(v);
    const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-' : '') + sym + abs;
  }
  function fmtDate(d) {
    if (!d) return '';
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(dt)) return '';
    return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtMonth(d) {
    const dt = typeof d === 'string' ? new Date(d) : d;
    return dt.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  function fmtRelative(d) {
    const dt = typeof d === 'string' ? new Date(d) : d;
    const days = Math.round((Date.now() - dt.getTime()) / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.round(days/30)}mo ago`;
    return `${Math.round(days/365)}y ago`;
  }
  function fmtPercent(p) {
    if (p == null || isNaN(p)) return '';
    const sign = p > 0 ? '+' : '';
    return `${sign}${(p * 100).toFixed(0)}%`;
  }

  // ============== IndexedDB ==============
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('settings'))      d.createObjectStore('settings', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('documents')) {
          const s = d.createObjectStore('documents', { keyPath: 'id' });
          s.createIndex('byDate', 'uploadedAt');
        }
        if (!d.objectStoreNames.contains('transactions')) {
          const s = d.createObjectStore('transactions', { keyPath: 'id' });
          s.createIndex('byDoc', 'documentId');
          s.createIndex('byDate', 'date');
        }
        if (!d.objectStoreNames.contains('lineItems')) {
          const s = d.createObjectStore('lineItems', { keyPath: 'id' });
          s.createIndex('byCanonical', 'canonical');
          s.createIndex('byTx', 'transactionId');
          s.createIndex('byDate', 'date');
        }
        if (!d.objectStoreNames.contains('merchantRules')) d.createObjectStore('merchantRules', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('itemAliases'))   d.createObjectStore('itemAliases', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const tx = (s, m='readonly') => db.transaction(s, m).objectStore(s);
  const dbGet  = (s, k) => new Promise((r, j) => { const q = tx(s).get(k); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const dbAll  = (s)    => new Promise((r, j) => { const q = tx(s).getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const dbPut  = (s, v) => new Promise((r, j) => { const q = tx(s, 'readwrite').put(v); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const dbDel  = (s, k) => new Promise((r, j) => { const q = tx(s, 'readwrite').delete(k); q.onsuccess = () => r(); q.onerror = () => j(q.error); });
  const dbClear= (s)    => new Promise((r, j) => { const q = tx(s, 'readwrite').clear(); q.onsuccess = () => r(); q.onerror = () => j(q.error); });

  // ============== Settings ==============
  async function loadSettings() {
    const onb = await dbGet('settings', 'onboarded');
    state.onboarded = !!(onb && onb.value);
    const cur = await dbGet('settings', 'currency');
    if (cur) state.settings.currency = cur.value;
    const th = await dbGet('settings', 'theme');
    if (th) state.settings.theme = th.value;
  }
  async function saveSetting(key, value) {
    await dbPut('settings', { key, value });
  }

  function applyTheme() {
    const t = state.settings.theme;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  // ============== Data load ==============
  async function loadAll() {
    const [docs, txs, items, rules, aliases] = await Promise.all([
      dbAll('documents'),
      dbAll('transactions'),
      dbAll('lineItems'),
      dbAll('merchantRules'),
      dbAll('itemAliases'),
    ]);
    state.documents = docs.sort((a,b) => b.uploadedAt - a.uploadedAt);
    state.transactions = txs;
    state.lineItems = items;
    state.merchantRules = Object.fromEntries(rules.map(r => [r.key, r.value]));
    state.itemAliases = Object.fromEntries(aliases.map(r => [r.key, r.value]));
  }

  // ============== Toast ==============
  let toastTimer;
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ============== Onboarding ==============
  function initOnboarding() {
    if (state.onboarded) {
      $('#onboarding').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#tabbar').classList.remove('hidden');
      return;
    }
    $('#onboarding').classList.remove('hidden');
    $$('#onboarding .cur-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#onboarding .cur-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.settings.currency = btn.dataset.cur;
      });
    });
    $('#onb-continue').addEventListener('click', async () => {
      await saveSetting('currency', state.settings.currency);
      await saveSetting('onboarded', true);
      state.onboarded = true;
      $('#onboarding').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#tabbar').classList.remove('hidden');
      renderAll();
    });
    // preselect USD
    const def = $('#onboarding .cur-btn[data-cur="USD"]');
    def && def.click();
  }

  // ============== Navigation ==============
  function showScreen(name) {
    state.activeTab = name;
    $$('main#app > .screen').forEach(s => {
      if (s.classList.contains('push')) return;
      s.classList.toggle('hidden', s.dataset.screen !== name);
    });
    $$('#tabbar .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    closePushScreens();
    window.scrollTo(0, 0);
  }

  function closePushScreens() {
    $$('main#app > .screen.push').forEach(s => s.classList.add('hidden'));
  }

  function openItemDetail(canonical) {
    renderItemDetail(canonical);
    $('[data-screen="itemdetail"]').classList.remove('hidden');
    window.scrollTo(0, 0);
  }
  function closeItemDetail() {
    $('[data-screen="itemdetail"]').classList.add('hidden');
  }

  // ============== Sheets ==============
  function openSheet(id) {
    $(`#${id}-backdrop`).classList.remove('hidden');
    $(`#${id}-sheet`).classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeSheet(id) {
    $(`#${id}-backdrop`).classList.add('hidden');
    $(`#${id}-sheet`).classList.add('hidden');
    document.body.style.overflow = '';
  }

  // ============== Categorization ==============
  function categorize(merchantOrItem) {
    const s = (merchantOrItem || '').toLowerCase();
    if (!s) return 'other';

    // explicit learned rule
    if (state.merchantRules[merchantOrItem]) return state.merchantRules[merchantOrItem];

    for (const cat of DEFAULT_CATEGORIES) {
      for (const kw of cat.keywords) {
        if (s.includes(kw)) return cat.id;
      }
    }
    return 'other';
  }

  // ============== Item normalization & matching ==============
  const QTY_UNIT_RE = /\b(\d+(\.\d+)?)\s?(lb|lbs|kg|g|gm|gms|oz|ml|l|lt|ltr|gal|ct|pk|pack|each|ea|count|cnt)\b/gi;
  const ABBREV_MAP = {
    'org': 'organic', 'orgnc': 'organic',
    'gv': '', 'ks': 'kirkland',
    'chkn': 'chicken', 'chk': 'chicken',
    'veg': 'vegetable', 'veggies': 'vegetable',
    'choc': 'chocolate', 'choco': 'chocolate',
    'tom': 'tomato', 'toms': 'tomato',
    'wht': 'whole', 'wh': 'whole',
    'bnls': 'boneless', 'sknlss': 'skinless',
    'frzn': 'frozen', 'frsh': 'fresh',
    'lrg': 'large', 'sm': 'small', 'med': 'medium',
    'pkt': 'packet', 'btl': 'bottle',
  };

  function normalizeItem(name) {
    if (!name) return '';
    let s = name.toLowerCase();
    s = s.replace(/[#*&®©™]/g, ' ');
    s = s.replace(/[^a-z0-9\s.]/g, ' ');
    s = s.replace(QTY_UNIT_RE, ' ');
    s = s.replace(/\b\d{4,}\b/g, ' '); // strip long codes
    const tokens = s.split(/\s+/).filter(Boolean).map(t => ABBREV_MAP[t] != null ? ABBREV_MAP[t] : t).filter(Boolean);
    return tokens.sort().join(' ');
  }

  function tokens(s) { return new Set(s.split(/\s+/).filter(Boolean)); }
  function jaccard(a, b) {
    const A = tokens(a), B = tokens(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }

  function findCanonical(rawName) {
    const norm = normalizeItem(rawName);
    if (!norm) return null;
    if (state.itemAliases[norm]) return state.itemAliases[norm];

    let bestId = null, bestScore = 0;
    for (const li of state.lineItems) {
      if (!li.canonical) continue;
      const score = jaccard(norm, li.normalizedName || normalizeItem(li.name));
      if (score > bestScore) { bestScore = score; bestId = li.canonical; }
    }
    if (bestScore >= 0.7) return bestId;
    return null;
  }

  function makeCanonicalId(rawName) {
    const norm = normalizeItem(rawName);
    return (norm || rawName).replace(/\s+/g, '-').slice(0, 60) || uid();
  }

  // ============== Library loaders ==============
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = import(PDFJS_CDN).then(mod => {
      const lib = mod.GlobalWorkerOptions ? mod : (mod.default || mod);
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
      return lib;
    });
    return pdfjsPromise;
  }

  let tesseractPromise = null;
  function loadTesseract() {
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = TESSERACT_CDN;
      s.onload = () => res(window.Tesseract);
      s.onerror = rej;
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }

  // ============== Ingest ==============
  async function ingestFiles(fileList) {
    const files = Array.from(fileList);
    for (const f of files) {
      try { await ingestOne(f); }
      catch (e) { console.error(e); toast(`Failed: ${f.name}`); }
    }
    await loadAll();
    renderInboxQueue();
    renderStatements();
    renderItems();
    renderInsights();
  }

  async function ingestOne(file) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImg = file.type.startsWith('image/');
    if (!isPdf && !isImg) { toast('Only PDF or images'); return; }

    const id = uid();
    const blob = file;
    const doc = {
      id,
      name: file.name,
      mime: file.type || (isPdf ? 'application/pdf' : 'image/jpeg'),
      size: file.size,
      uploadedAt: Date.now(),
      blob,
      status: 'parsing',
      kind: isPdf ? 'pdf' : 'image',
    };
    await dbPut('documents', doc);
    state.documents.unshift(doc);
    renderInboxQueue();

    let text = '';
    try {
      if (isPdf) text = await extractPdfText(blob);
      else       text = await extractImageText(blob);
    } catch (e) {
      console.error('extract failed', e);
      doc.status = 'error';
      doc.error = String(e.message || e);
      await dbPut('documents', doc);
      renderInboxQueue();
      return;
    }

    doc.text = text;
    const parsed = parseDocument(text, file.name);
    doc.parsed = parsed;
    doc.status = parsed.lineItems.length > 0 || parsed.total ? 'ready' : 'review';

    const transaction = {
      id: uid(),
      documentId: id,
      store: parsed.store,
      date: parsed.date || new Date(doc.uploadedAt).toISOString().slice(0,10),
      total: parsed.total,
      currency: parsed.currency || state.settings.currency,
      category: categorize(parsed.store),
      docKind: doc.kind,
      docType: parsed.docType,
    };
    await dbPut('transactions', transaction);

    for (const li of parsed.lineItems) {
      const canonical = findCanonical(li.name) || makeCanonicalId(li.name);
      const item = {
        id: uid(),
        transactionId: transaction.id,
        documentId: id,
        name: li.name,
        normalizedName: normalizeItem(li.name),
        canonical,
        qty: li.qty || 1,
        unitPrice: li.unitPrice ?? li.lineTotal ?? null,
        lineTotal: li.lineTotal ?? null,
        store: parsed.store,
        date: transaction.date,
        category: categorize(li.name) || transaction.category,
      };
      await dbPut('lineItems', item);

      // remember alias for future fast match
      if (item.normalizedName) {
        state.itemAliases[item.normalizedName] = canonical;
        await dbPut('itemAliases', { key: item.normalizedName, value: canonical });
      }
    }

    await dbPut('documents', doc);
  }

  async function extractPdfText(blob) {
    const lib = await loadPdfJs();
    const buf = await blob.arrayBuffer();
    const pdf = await lib.getDocument({ data: buf }).promise;
    const out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const pageText = content.items.map(i => i.str).join(' ');
      out.push(pageText);
    }
    return out.join('\n\n');
  }

  async function extractImageText(blob) {
    const T = await loadTesseract();
    const url = URL.createObjectURL(blob);
    try {
      const { data } = await T.recognize(url, 'eng');
      return data.text || '';
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ============== Parser ==============
  function parseDocument(text, filename = '') {
    const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const joined = lines.join('\n');

    // Strong signals — unambiguous structural cues
    const STRONG_STATEMENT = /\b(statement period|account statement|narration|withdrawal\s+deposit|opening\s+balance|closing\s+balance|cardholder|posting\s+date|chq\/?ref)\b/i;
    const STRONG_RECEIPT   = /\b(subtotal|sub\s*total|sales\s*tax|tendered|cash\s*tend|gst|cgst|sgst|change\s+due)\b/i;

    if (STRONG_STATEMENT.test(joined)) return parseStatement(lines, filename);
    if (STRONG_RECEIPT.test(joined))   return parseReceipt(lines, filename);

    // Weak fallback — guess by structure (many date+amount lines = statement)
    const dateAmtLines = lines.filter(l => /\d{1,2}[\/\-]\d{1,2}/.test(l) && /\d[\d,]*\.\d{2}\s*$/.test(l));
    if (dateAmtLines.length >= 5) return parseStatement(lines, filename);
    return parseReceipt(lines, filename);
  }

  // -------- Receipt parsing --------
  function parseReceipt(lines, filename) {
    const store = guessStore(lines);
    const date = guessDate(lines);
    const currency = guessCurrency(lines);
    const total = guessTotal(lines);
    const lineItems = [];

    // skip header lines (first 5) and footer-ish lines that aren't products
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

      // qty patterns:  "2 @ 1.50"  "2x 1.50"  "2.13 lb @ 0.58"
      let qty = 1, unitPrice = price;
      const qtyAt = head.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|kg|g|gm|oz|ml|l|lt|ltr|gal|ct|pk|each|ea|count|cnt)?\s*(?:@|x|×)\s*(\d+(?:\.\d+)?)/i);
      if (qtyAt) {
        qty = parseFloat(qtyAt[1]);
        unitPrice = parseFloat(qtyAt[2]);
        head = head.replace(qtyAt[0], '').trim();
      }

      // Clean up the displayed name
      head = head.replace(/\b\d{8,}\b/g, ' ');     // strip long SKU codes
      head = head.replace(/\/[a-z]+/gi, ' ');       // strip per-unit suffix "/lb"
      head = head.replace(/\s+/g, ' ').trim();
      head = head.replace(/^\d{4,}\s+/, '').trim(); // strip leading code
      head = head.replace(/^[A-Z]\s+/, '').trim();
      if (head.length < 2) continue;

      lineItems.push({ name: head, qty, unitPrice, lineTotal: price });
    }

    return { docType: 'receipt', store, date, currency, total, lineItems };
  }

  // -------- Bank statement parsing --------
  function parseStatement(lines, filename) {
    const issuer = guessStore(lines) || 'Bank statement';
    const currency = guessCurrency(lines);
    const date = guessDate(lines) || new Date().toISOString().slice(0,10);
    const lineItems = []; // each transaction becomes a "line item" with qty=1, store=merchant

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
      // For statements: ignore credits (incoming money). Keep debits.
      if (drcr && /CR/i.test(drcr)) continue;

      let merchant = line.slice(dateMatch.index + dateMatch[0].length, amtMatch.index).trim();
      merchant = merchant.replace(/^[\s|·]+|[\s|·]+$/g, '');
      merchant = merchant.replace(/\s{2,}/g, ' ');
      if (merchant.length < 2) continue;

      lineItems.push({
        name: merchant,
        qty: 1,
        unitPrice: amount,
        lineTotal: amount,
        date: txDate,
      });
      total += amount;
    }

    return { docType: 'statement', store: issuer, date, currency, total, lineItems };
  }

  function parseLooseDate(s) {
    const today = new Date();
    if (!s) return today.toISOString().slice(0,10);
    let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
    if (m) {
      let [_, a, b, c] = m;
      let yr = c ? (c.length === 2 ? 2000 + parseInt(c,10) : parseInt(c,10)) : today.getFullYear();
      // Heuristic: if first part > 12 it's day-first; otherwise assume month-first (US default for receipts)
      const first = parseInt(a,10), second = parseInt(b,10);
      let mo, day;
      if (first > 12) { day = first; mo = second; }
      else if (second > 12) { mo = first; day = second; }
      else { mo = first; day = second; } // ambiguous → MDY
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
    // first non-empty short uppercase line is likely the store name
    for (const l of lines.slice(0, 6)) {
      if (l.length >= 3 && l.length <= 30 && l === l.toUpperCase() && /[A-Z]/.test(l)) {
        return capitalize(l.toLowerCase());
      }
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
    return state.settings.currency;
  }

  function guessTotal(lines) {
    // search bottom-up for a TOTAL line
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
    for (const l of lines.slice(0, 30)) {
      const m = l.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/) || l.match(/(\d{1,2}\s[A-Z][a-z]{2}\s\d{2,4})/);
      if (m) return parseLooseDate(m[1]);
    }
    return null;
  }

  // ============== Renderers ==============
  function renderAll() {
    renderInboxQueue();
    renderItems();
    renderStatements();
    renderInsights();
  }

  // ----- Inbox -----
  function renderInboxQueue() {
    const list = $('#queue-list');
    const empty = $('#queue-empty');
    list.innerHTML = '';
    if (!state.documents.length) {
      empty.classList.remove('hidden');
      list.classList.add('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.classList.remove('hidden');

    state.documents.slice(0, 30).forEach(doc => {
      const tx = state.transactions.find(t => t.documentId === doc.id);
      const items = state.lineItems.filter(li => li.documentId === doc.id);
      const itemCount = items.length;
      const status = doc.status || 'ready';
      const statusLabel = status === 'parsing' ? 'Parsing' : status === 'review' ? 'Review' : status === 'error' ? 'Failed' : 'Ready';

      const row = el('button', { class: 'row queue-row' }, [
        el('div', { class: 'queue-thumb' }, doc.kind === 'pdf' ? 'PDF' : '🖼'),
        el('div', { class: 'queue-info' }, [
          el('p', { class: 'queue-name ellipsis' }, doc.name),
          el('p', { class: 'queue-meta' },
            (tx ? `${tx.store || 'Unknown'} · ${itemCount} item${itemCount===1?'':'s'} · ${fmtRelative(doc.uploadedAt)}` : fmtRelative(doc.uploadedAt))
          ),
        ]),
        el('span', { class: `pill ${status}` }, statusLabel),
      ]);
      row.addEventListener('click', () => openReview(doc.id));
      list.appendChild(row);
    });
  }

  // ----- Items -----
  function renderItems() {
    const empty = $('#items-empty');
    const list  = $('#items-list');
    list.innerHTML = '';
    if (!state.lineItems.length) {
      empty.classList.remove('hidden');
      list.classList.add('hidden');
      renderItemsChips();
      return;
    }
    empty.classList.add('hidden');
    list.classList.remove('hidden');
    renderItemsChips();

    // group by canonical
    const groups = new Map();
    for (const li of state.lineItems) {
      if (!li.canonical) continue;
      const arr = groups.get(li.canonical) || [];
      arr.push(li);
      groups.set(li.canonical, arr);
    }

    let aggregated = [];
    for (const [canonical, arr] of groups.entries()) {
      arr.sort((a,b) => (b.date||'').localeCompare(a.date||''));
      const latest = arr[0];
      const previous = arr[1];
      const delta = previous && latest.unitPrice != null && previous.unitPrice != null && previous.unitPrice > 0
        ? (latest.unitPrice - previous.unitPrice) / previous.unitPrice : null;
      aggregated.push({
        canonical,
        name: latest.name,
        store: latest.store,
        category: latest.category,
        latest,
        previous,
        delta,
        count: arr.length,
        recentDate: latest.date,
      });
    }

    // filter
    const f = state.itemFilter;
    if (f.search) {
      const q = f.search.toLowerCase();
      aggregated = aggregated.filter(a => a.name.toLowerCase().includes(q));
    }
    if (f.category !== 'all') {
      aggregated = aggregated.filter(a => a.category === f.category);
    }
    if (f.store !== 'all') {
      aggregated = aggregated.filter(a => a.store === f.store);
    }

    // sort
    switch (state.itemSort) {
      case 'jump': aggregated.sort((a,b) => (Math.abs(b.delta||0)) - (Math.abs(a.delta||0))); break;
      case 'alpha': aggregated.sort((a,b) => a.name.localeCompare(b.name)); break;
      case 'bought': aggregated.sort((a,b) => b.count - a.count); break;
      default: aggregated.sort((a,b) => (b.recentDate||'').localeCompare(a.recentDate||''));
    }

    aggregated.slice(0, 200).forEach(a => {
      const deltaClass = a.delta == null ? 'flat' : a.delta > 0.01 ? 'up' : a.delta < -0.01 ? 'down' : 'flat';
      const deltaText  = a.delta == null ? '—' : fmtPercent(a.delta);
      const catName = CATEGORY_BY_ID[a.category]?.name || 'Other';

      const row = el('div', { class: 'row item-row' }, [
        el('div', { class: 'left' }, [
          el('p', { class: 'item-name ellipsis' }, a.name),
          el('p', { class: 'item-meta' }, [
            a.store || 'Unknown',
            el('span', { class: 'dot' }, '·'),
            catName,
            el('span', { class: 'dot' }, '·'),
            `${a.count}×`,
          ]),
        ]),
        el('div', { class: 'item-right' }, [
          el('span', { class: 'price' }, fmtCurrency(a.latest.unitPrice)),
          el('span', { class: `delta ${deltaClass}` }, deltaText),
        ]),
      ]);
      row.addEventListener('click', () => openItemDetail(a.canonical));
      list.appendChild(row);
    });
  }

  function renderItemsChips() {
    const rail = $('#items-chips');
    rail.innerHTML = '';
    const cats = ['all', ...DEFAULT_CATEGORIES.map(c => c.id)];
    cats.forEach(cid => {
      const label = cid === 'all' ? 'All' : CATEGORY_BY_ID[cid].name;
      const chip = el('button', { class: 'chip' + (state.itemFilter.category === cid ? ' active' : '') }, label);
      chip.addEventListener('click', () => { state.itemFilter.category = cid; renderItems(); });
      rail.appendChild(chip);
    });

    const stores = Array.from(new Set(state.lineItems.map(li => li.store).filter(Boolean)));
    if (stores.length) {
      rail.appendChild(el('div', { class: 'chip-divider' }));
      ['all', ...stores].forEach(s => {
        const label = s === 'all' ? 'Any store' : s;
        const chip = el('button', { class: 'chip' + (state.itemFilter.store === s ? ' active' : '') }, label);
        chip.addEventListener('click', () => { state.itemFilter.store = s; renderItems(); });
        rail.appendChild(chip);
      });
    }
  }

  // ----- Item Detail -----
  function renderItemDetail(canonical) {
    const items = state.lineItems.filter(li => li.canonical === canonical);
    if (!items.length) { closeItemDetail(); return; }
    items.sort((a,b) => (b.date||'').localeCompare(a.date||''));
    const latest = items[0];
    const previous = items[1];

    $('#itemdetail-title').textContent = latest.name;
    $('#itd-name').textContent = latest.name;
    $('#itd-store').textContent = latest.store || '';
    $('#itd-category').textContent = (CATEGORY_BY_ID[latest.category]?.name || 'OTHER').toUpperCase();
    $('#itd-price').textContent = fmtCurrency(latest.unitPrice);

    const deltaEl = $('#itd-delta');
    if (previous && latest.unitPrice != null && previous.unitPrice) {
      const d = (latest.unitPrice - previous.unitPrice) / previous.unitPrice;
      deltaEl.textContent = fmtPercent(d);
      deltaEl.className = 'delta ' + (d > 0.01 ? 'up' : d < -0.01 ? 'down' : 'flat');
    } else { deltaEl.textContent = ''; }

    const validPrices = items.map(i => i.unitPrice).filter(p => p != null && p > 0);
    const avg = validPrices.length ? validPrices.reduce((a,b)=>a+b,0) / validPrices.length : null;
    $('#itd-avg').textContent = fmtCurrency(avg);
    $('#itd-count').textContent = String(items.length);

    if (items.length >= 2) {
      const dates = items.map(i => new Date(i.date).getTime()).sort((a,b)=>a-b);
      const span = (dates[dates.length-1] - dates[0]) / 86400000;
      const freq = span > 0 ? span / (items.length - 1) : 0;
      $('#itd-freq').textContent = freq > 0 ? `every ~${Math.round(freq)}d` : '—';
    } else { $('#itd-freq').textContent = '—'; }

    drawSparkline(items);
    renderItemVendors(items);
    renderItemPurchases(items);
  }

  function drawSparkline(items) {
    const svg = $('#itd-spark');
    svg.innerHTML = '';
    const points = items.slice().reverse().map(i => ({ x: new Date(i.date).getTime(), y: i.unitPrice })).filter(p => p.y != null);
    if (points.length < 2) return;
    const w = 300, h = 80, pad = 6;
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = Math.min(...ys), ymax = Math.max(...ys);
    const sx = x => pad + ((x - xmin) / Math.max(1, xmax - xmin)) * (w - pad*2);
    const sy = y => h - pad - ((y - ymin) / Math.max(0.001, ymax - ymin)) * (h - pad*2);
    const path = points.map((p, i) => `${i===0?'M':'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    const ns = 'http://www.w3.org/2000/svg';
    const pathEl = document.createElementNS(ns, 'path');
    pathEl.setAttribute('class', 'line');
    pathEl.setAttribute('d', path);
    svg.appendChild(pathEl);
    points.forEach((p, i) => {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', sx(p.x));
      c.setAttribute('cy', sy(p.y));
      const isExtreme = (p.y === ymin || p.y === ymax);
      c.setAttribute('r', isExtreme ? 3 : 2);
      c.setAttribute('class', 'dot' + (isExtreme ? ' minmax' : ''));
      svg.appendChild(c);
    });
  }

  function renderItemVendors(items) {
    const list = $('#itd-vendors');
    list.innerHTML = '';
    const byStore = new Map();
    for (const i of items) {
      const s = i.store || 'Unknown';
      const arr = byStore.get(s) || [];
      arr.push(i);
      byStore.set(s, arr);
    }
    const rows = Array.from(byStore.entries()).map(([store, arr]) => {
      arr.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
      const latest = arr[0];
      const min = Math.min(...arr.map(i => i.unitPrice).filter(p => p!=null && p>0));
      return { store, latest, min, count: arr.length };
    });
    const overallMin = Math.min(...rows.map(r => r.min));

    rows.forEach(r => {
      const isCheapest = r.min === overallMin && rows.length > 1;
      const row = el('div', { class: 'row vendor-row' }, [
        el('div', {}, [
          el('p', { class: 'item-name' }, [
            r.store,
            isCheapest ? el('span', { class: 'caption', style: 'color:var(--success); margin-left:8px' }, 'CHEAPEST') : null,
          ].filter(Boolean)),
          el('p', { class: 'item-meta' }, `${r.count} purchase${r.count===1?'':'s'}`),
        ]),
        el('div', { class: 'item-right' }, [
          el('span', { class: 'price' }, fmtCurrency(r.latest.unitPrice)),
          el('span', { class: 'item-meta small' }, fmtRelative(r.latest.date)),
        ]),
      ]);
      list.appendChild(row);
    });
  }

  function renderItemPurchases(items) {
    const list = $('#itd-purchases');
    list.innerHTML = '';
    items.forEach(i => {
      const row = el('div', { class: 'row purchase-row' }, [
        el('div', {}, [
          el('p', { class: 'small bold' }, fmtDate(i.date)),
          el('p', { class: 'item-meta' }, [
            i.store || 'Unknown',
            i.qty && i.qty > 1 ? el('span', {}, ` · ${i.qty}×`) : null,
          ].filter(Boolean)),
        ]),
        el('div', { class: 'item-right' }, [
          el('span', { class: 'price' }, fmtCurrency(i.unitPrice)),
          i.lineTotal != null && i.qty > 1 ? el('span', { class: 'item-meta small' }, `total ${fmtCurrency(i.lineTotal)}`) : null,
        ].filter(Boolean)),
      ]);
      row.addEventListener('click', () => openViewer(i.documentId));
      list.appendChild(row);
    });
  }

  // ----- Statements -----
  function renderStatements() {
    const root = $('#statements-list');
    const empty = $('#statements-empty');
    root.innerHTML = '';
    if (!state.documents.length) {
      empty.classList.remove('hidden');
      root.classList.add('hidden');
      return;
    }
    empty.classList.add('hidden');
    root.classList.remove('hidden');

    // group by month
    const byMonth = new Map();
    state.documents.forEach(doc => {
      const tx = state.transactions.find(t => t.documentId === doc.id);
      const date = tx?.date || new Date(doc.uploadedAt).toISOString().slice(0,10);
      const key = date.slice(0, 7);
      const arr = byMonth.get(key) || [];
      arr.push({ doc, tx, date });
      byMonth.set(key, arr);
    });

    Array.from(byMonth.keys()).sort((a,b)=>b.localeCompare(a)).forEach(monthKey => {
      const sec = el('section', { class: 'month-section' });
      sec.appendChild(el('p', { class: 'month-h' }, fmtMonth(monthKey + '-01')));
      const rows = byMonth.get(monthKey).sort((a,b) => b.date.localeCompare(a.date));
      rows.forEach(({ doc, tx, date }) => {
        const items = state.lineItems.filter(li => li.documentId === doc.id);
        const itemCount = items.length;
        const row = el('div', { class: 'row stmt-row' }, [
          el('div', { class: 'stmt-thumb' }, doc.kind === 'pdf' ? 'PDF' : 'IMG'),
          el('div', {}, [
            el('p', { class: 'stmt-name ellipsis' }, tx?.store || doc.name),
            el('p', { class: 'stmt-meta' }, `${fmtDate(date)} · ${itemCount} item${itemCount===1?'':'s'}`),
          ]),
          el('div', { class: 'stmt-right' }, [
            el('span', { class: 'stmt-total' }, tx?.total != null ? fmtCurrency(tx.total) : '—'),
          ]),
        ]);
        row.addEventListener('click', () => openViewer(doc.id));
        sec.appendChild(row);
      });
      root.appendChild(sec);
    });
  }

  // ----- Insights -----
  function renderInsights() {
    const empty = $('#insights-empty');
    if (state.lineItems.length < 2 && state.transactions.length < 2) {
      empty.classList.remove('hidden');
      $$('.insight-block').forEach(b => b.classList.add('hidden'));
      return;
    }
    empty.classList.add('hidden');
    $$('.insight-block').forEach(b => b.classList.remove('hidden'));

    const cutoff = state.insightsPeriod === 'all' ? 0 : Date.now() - state.insightsPeriod * 86400000;
    const inWindow = li => !cutoff || new Date(li.date).getTime() >= cutoff;

    // Biggest jumps: items with >=2 purchases, latest in window, biggest |delta|
    const groups = new Map();
    for (const li of state.lineItems) {
      const arr = groups.get(li.canonical) || [];
      arr.push(li);
      groups.set(li.canonical, arr);
    }
    const jumps = [];
    for (const [canonical, arr] of groups) {
      arr.sort((a,b) => (b.date||'').localeCompare(a.date||''));
      const latest = arr[0], prev = arr[1];
      if (!latest || !prev || !inWindow(latest)) continue;
      if (latest.unitPrice == null || !prev.unitPrice) continue;
      const d = (latest.unitPrice - prev.unitPrice) / prev.unitPrice;
      if (Math.abs(d) < 0.02) continue;
      jumps.push({ canonical, name: latest.name, store: latest.store, latest, prev, delta: d });
    }
    jumps.sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta));
    renderInsRows('#ins-jumps-rows', jumps.slice(0, 5).map(j => ({
      name: j.name,
      sub: `${fmtCurrency(j.prev.unitPrice)} → ${fmtCurrency(j.latest.unitPrice)} · ${j.store || ''}`,
      right: el('span', { class: `delta ${j.delta > 0 ? 'up' : 'down'}` }, fmtPercent(j.delta)),
      onClick: () => openItemDetail(j.canonical),
    })));

    // Most bought: count purchases in window
    const counts = [];
    for (const [canonical, arr] of groups) {
      const inW = arr.filter(inWindow);
      if (!inW.length) continue;
      counts.push({ canonical, name: inW[0].name, count: inW.length, total: inW.reduce((s,i) => s + (i.lineTotal ?? i.unitPrice ?? 0) * 1, 0) });
    }
    counts.sort((a,b) => b.count - a.count);
    renderInsRows('#ins-mostbought-rows', counts.slice(0, 5).map(c => ({
      name: c.name,
      sub: `${c.count} purchases · spent ${fmtCurrency(c.total)}`,
      right: el('span', { class: 'price' }, `${c.count}×`),
      onClick: () => openItemDetail(c.canonical),
    })));

    // Cheapest store per category
    const catBest = {};
    for (const li of state.lineItems) {
      if (!inWindow(li) || li.unitPrice == null || li.unitPrice <= 0) continue;
      const c = li.category || 'other';
      if (!catBest[c] || li.unitPrice < catBest[c].unitPrice) catBest[c] = li;
    }
    // Pick categories that have >=2 stores represented for honesty
    const categoriesWithMultiStore = {};
    for (const li of state.lineItems) {
      if (!inWindow(li)) continue;
      const c = li.category || 'other';
      categoriesWithMultiStore[c] = categoriesWithMultiStore[c] || new Set();
      if (li.store) categoriesWithMultiStore[c].add(li.store);
    }
    const cheapestRows = Object.entries(catBest)
      .filter(([c]) => (categoriesWithMultiStore[c]?.size || 0) >= 2)
      .slice(0, 6);
    renderInsRows('#ins-cheapest-rows', cheapestRows.map(([cat, li]) => ({
      name: CATEGORY_BY_ID[cat]?.name || 'Other',
      sub: `${li.name} at ${li.store || 'Unknown'}`,
      right: el('span', { class: 'price' }, fmtCurrency(li.unitPrice)),
    })));

    // Top spend by category (use transactions' totals, else sum line items)
    const catSpend = {};
    let grandTotal = 0;
    for (const t of state.transactions) {
      if (cutoff && new Date(t.date).getTime() < cutoff) continue;
      const c = t.category || 'other';
      const amt = t.total || state.lineItems.filter(li => li.transactionId === t.id).reduce((s,li) => s + (li.lineTotal ?? li.unitPrice ?? 0), 0);
      catSpend[c] = (catSpend[c] || 0) + amt;
      grandTotal += amt;
    }
    const topspend = Object.entries(catSpend).sort((a,b) => b[1] - a[1]).slice(0, 6);
    const maxSpend = topspend.length ? topspend[0][1] : 0;
    const target = $('#ins-topspend-rows');
    target.innerHTML = '';
    topspend.forEach(([cat, amount]) => {
      const pct = maxSpend > 0 ? amount / maxSpend : 0;
      const row = el('div', { class: 'ins-row' }, [
        el('div', { class: 'left' }, [
          el('p', { class: 'name' }, CATEGORY_BY_ID[cat]?.name || 'Other'),
          el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: `width:${(pct*100).toFixed(0)}%` })),
        ]),
        el('div', { class: 'right' }, el('span', { class: 'price' }, fmtCurrency(amount))),
      ]);
      target.appendChild(row);
    });

    if (!jumps.length) $('#ins-jumps-rows').innerHTML = `<p class="muted small">Not enough repeat purchases yet.</p>`;
    if (!counts.length) $('#ins-mostbought-rows').innerHTML = `<p class="muted small">No purchases in this window.</p>`;
    if (!cheapestRows.length) $('#ins-cheapest-rows').innerHTML = `<p class="muted small">Need items from at least 2 stores per category.</p>`;
    if (!topspend.length) $('#ins-topspend-rows').innerHTML = `<p class="muted small">No spend recorded.</p>`;
  }

  function renderInsRows(sel, rows) {
    const root = $(sel);
    root.innerHTML = '';
    rows.forEach(r => {
      const row = el('div', { class: 'row ins-row' }, [
        el('div', { class: 'left' }, [
          el('p', { class: 'name ellipsis' }, r.name),
          el('p', { class: 'sub ellipsis' }, r.sub || ''),
        ]),
        el('div', { class: 'right' }, r.right),
      ]);
      if (r.onClick) row.addEventListener('click', r.onClick);
      root.appendChild(row);
    });
  }

  // ============== Review sheet ==============
  function openReview(docId) {
    const doc = state.documents.find(d => d.id === docId);
    if (!doc) return;
    if (doc.status === 'parsing') { toast('Still parsing…'); return; }
    if (doc.status === 'error') {
      $('#review-title').textContent = 'Failed to read';
      $('#review-sub').textContent = doc.name;
      $('#review-body').innerHTML = `<p class="muted small">${doc.error || 'Could not extract text.'}</p>`;
      $('#review-save').textContent = 'Close';
      state.activeReview = { docId, mode: 'error' };
      openSheet('review');
      return;
    }

    const tx = state.transactions.find(t => t.documentId === docId);
    const items = state.lineItems.filter(li => li.documentId === docId).slice();
    state.activeReview = { docId, txId: tx?.id, items };

    $('#review-title').textContent = tx?.store || doc.name;
    $('#review-sub').textContent = `${fmtDate(tx?.date)} · ${items.length} item${items.length===1?'':'s'}`;
    const body = $('#review-body');
    body.innerHTML = '';

    items.forEach((li, idx) => {
      const row = el('div', { class: 'review-row' }, [
        el('input', { type: 'text', value: li.name, 'data-i': idx, 'data-f': 'name' }),
        el('input', { type: 'number', step: '0.01', class: 'num', inputmode: 'decimal', value: (li.qty ?? 1), 'data-i': idx, 'data-f': 'qty' }),
        el('input', { type: 'number', step: '0.01', class: 'num', inputmode: 'decimal', value: (li.unitPrice ?? ''), 'data-i': idx, 'data-f': 'price' }),
      ]);
      body.appendChild(row);
    });

    if (items.length === 0) {
      body.appendChild(el('p', { class: 'muted small' }, 'No items parsed. Tap "+ Add item" to add manually.'));
    }

    const summary = el('div', { class: 'review-summary' }, [
      el('span', {}, 'Total'),
      el('span', { class: 'price' }, fmtCurrency(tx?.total)),
    ]);
    body.appendChild(summary);

    const addBtn = el('button', { class: 'review-add' }, '+ Add item');
    addBtn.addEventListener('click', () => addReviewRow(body));
    body.appendChild(addBtn);

    $('#review-save').textContent = 'Save changes';
    openSheet('review');
  }

  function addReviewRow(body) {
    const idx = state.activeReview.items.length;
    state.activeReview.items.push({ id: uid(), name: '', qty: 1, unitPrice: 0, isNew: true });
    const summary = body.querySelector('.review-summary');
    const row = el('div', { class: 'review-row' }, [
      el('input', { type: 'text', value: '', 'data-i': idx, 'data-f': 'name', placeholder: 'Item name' }),
      el('input', { type: 'number', step: '0.01', class: 'num', inputmode: 'decimal', value: 1, 'data-i': idx, 'data-f': 'qty' }),
      el('input', { type: 'number', step: '0.01', class: 'num', inputmode: 'decimal', value: '', 'data-i': idx, 'data-f': 'price', placeholder: '0.00' }),
    ]);
    body.insertBefore(row, summary);
    row.querySelector('input').focus();
  }

  async function saveReview() {
    const r = state.activeReview;
    if (!r) { closeSheet('review'); return; }
    if (r.mode === 'error') { closeSheet('review'); return; }

    const inputs = $$('#review-body input');
    const items = r.items.map(i => ({ ...i }));
    inputs.forEach(inp => {
      const i = +inp.dataset.i, f = inp.dataset.f;
      if (!items[i]) return;
      if (f === 'name') items[i].name = inp.value.trim();
      else if (f === 'qty') items[i].qty = parseFloat(inp.value) || 1;
      else if (f === 'price') items[i].unitPrice = parseFloat(inp.value) || 0;
    });

    // delete existing items for this doc, re-add (simpler than diffing)
    const existing = state.lineItems.filter(li => li.documentId === r.docId);
    for (const li of existing) await dbDel('lineItems', li.id);

    const doc = state.documents.find(d => d.id === r.docId);
    const txn = state.transactions.find(t => t.documentId === r.docId);
    let total = 0;
    for (const it of items) {
      if (!it.name) continue;
      const lineTotal = (it.unitPrice || 0) * (it.qty || 1);
      total += lineTotal;
      const canonical = findCanonical(it.name) || makeCanonicalId(it.name);
      const stored = {
        id: it.id || uid(),
        transactionId: txn?.id,
        documentId: r.docId,
        name: it.name,
        normalizedName: normalizeItem(it.name),
        canonical,
        qty: it.qty || 1,
        unitPrice: it.unitPrice ?? 0,
        lineTotal,
        store: txn?.store,
        date: txn?.date || new Date(doc.uploadedAt).toISOString().slice(0,10),
        category: categorize(it.name) || txn?.category || 'other',
      };
      await dbPut('lineItems', stored);
      if (stored.normalizedName) {
        state.itemAliases[stored.normalizedName] = canonical;
        await dbPut('itemAliases', { key: stored.normalizedName, value: canonical });
      }
    }

    if (txn && (!txn.total || Math.abs(txn.total - total) > 0.01)) {
      txn.total = total;
      await dbPut('transactions', txn);
    }
    if (doc) {
      doc.status = 'ready';
      await dbPut('documents', doc);
    }

    await loadAll();
    renderAll();
    closeSheet('review');
    toast('Saved');
  }

  // ============== Viewer ==============
  function openViewer(docId) {
    const doc = state.documents.find(d => d.id === docId);
    if (!doc) return;
    state.activeReview = { docId };
    $('#viewer-title').textContent = doc.name;
    const body = $('#viewer-body');
    body.innerHTML = '';

    if (doc.kind === 'image') {
      const url = URL.createObjectURL(doc.blob);
      body.appendChild(el('img', { src: url, alt: doc.name }));
    } else {
      const url = URL.createObjectURL(doc.blob);
      body.appendChild(el('iframe', { src: url, title: doc.name }));
    }
    if (doc.text) {
      const det = el('details', { style: 'border-top:1px solid var(--border); margin-top:0' });
      const sum = el('summary', { class: 'row', style: 'padding:14px 20px; font-weight:500; cursor:pointer' }, 'Extracted text');
      det.appendChild(sum);
      det.appendChild(el('pre', { class: 'viewer-text' }, doc.text));
      body.appendChild(det);
    }
    openSheet('viewer');
  }

  async function deleteCurrentDoc() {
    const r = state.activeReview;
    if (!r) return;
    if (!confirm('Delete this document and all its items?')) return;
    const items = state.lineItems.filter(li => li.documentId === r.docId);
    for (const li of items) await dbDel('lineItems', li.id);
    const txns = state.transactions.filter(t => t.documentId === r.docId);
    for (const t of txns) await dbDel('transactions', t.id);
    await dbDel('documents', r.docId);
    await loadAll();
    renderAll();
    closeSheet('viewer');
    toast('Deleted');
  }

  // ============== Settings actions ==============
  async function exportData() {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      transactions: state.transactions,
      lineItems: state.lineItems,
      merchantRules: state.merchantRules,
      itemAliases: state.itemAliases,
      documents: state.documents.map(d => ({
        id: d.id, name: d.name, mime: d.mime, size: d.size,
        uploadedAt: d.uploadedAt, status: d.status, kind: d.kind, text: d.text,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `pricewatch-backup-${new Date().toISOString().slice(0,10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Exported');
  }

  async function importData(file) {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch { toast('Invalid JSON'); return; }
    if (!confirm('Import will merge with current data. Continue?')) return;
    if (data.transactions) for (const t of data.transactions) await dbPut('transactions', t);
    if (data.lineItems)    for (const i of data.lineItems)    await dbPut('lineItems', i);
    if (data.merchantRules) for (const [k,v] of Object.entries(data.merchantRules)) await dbPut('merchantRules', { key: k, value: v });
    if (data.itemAliases)   for (const [k,v] of Object.entries(data.itemAliases))   await dbPut('itemAliases',   { key: k, value: v });
    await loadAll();
    renderAll();
    toast('Imported');
  }

  async function clearAllData() {
    if (!confirm('Erase ALL data? This cannot be undone.')) return;
    if (!confirm('Really erase everything?')) return;
    for (const s of ['documents','transactions','lineItems','merchantRules','itemAliases','settings']) await dbClear(s);
    state.onboarded = false;
    location.reload();
  }

  // ============== Wire up ==============
  function wire() {
    // Tabs
    $$('#tabbar .tab').forEach(t => t.addEventListener('click', () => showScreen(t.dataset.tab)));

    // Settings
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const a = t.dataset.action;
      if (a === 'open-settings') { syncSettingsControls(); openSheet('settings'); }
      if (a === 'close-settings') closeSheet('settings');
      if (a === 'close-review') closeSheet('review');
      if (a === 'close-viewer') closeSheet('viewer');
      if (a === 'close-sort') closeSheet('sort');
      if (a === 'back-to-items') closeItemDetail();
      if (a === 'items-sort') openSheet('sort');
      if (a === 'viewer-delete') deleteCurrentDoc();
    });
    $('#settings-backdrop').addEventListener('click', () => closeSheet('settings'));
    $('#review-backdrop').addEventListener('click', () => closeSheet('review'));
    $('#viewer-backdrop').addEventListener('click', () => closeSheet('viewer'));
    $('#sort-backdrop').addEventListener('click', () => closeSheet('sort'));

    $('#set-theme').addEventListener('change', async (e) => {
      state.settings.theme = e.target.value;
      await saveSetting('theme', e.target.value);
      applyTheme();
    });
    $('#set-currency').addEventListener('change', async (e) => {
      state.settings.currency = e.target.value;
      await saveSetting('currency', e.target.value);
      renderAll();
    });
    $('#export-btn').addEventListener('click', exportData);
    $('#import-input').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value=''; });
    $('#clear-btn').addEventListener('click', clearAllData);

    // Review save
    $('#review-save').addEventListener('click', saveReview);

    // Sort options
    $$('.sort-opt').forEach(opt => opt.addEventListener('click', () => {
      state.itemSort = opt.dataset.sort;
      $$('.sort-opt').forEach(o => o.classList.toggle('active', o === opt));
      renderItems();
      closeSheet('sort');
    }));

    // Items search
    $('#items-search').addEventListener('input', (e) => {
      state.itemFilter.search = e.target.value;
      renderItems();
    });

    // Insights period
    $$('#insights-period .seg-btn').forEach(b => b.addEventListener('click', () => {
      $$('#insights-period .seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.insightsPeriod = b.dataset.period === 'all' ? 'all' : parseInt(b.dataset.period, 10);
      renderInsights();
    }));

    // Drop zone
    const dz = $('#dropzone');
    const inp = $('#file-input');
    dz.addEventListener('click', () => inp.click());
    inp.addEventListener('change', (e) => {
      if (e.target.files.length) ingestFiles(e.target.files);
      e.target.value = '';
    });
    ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => {
      const files = e.dataTransfer?.files;
      if (files?.length) ingestFiles(files);
    });
  }

  function syncSettingsControls() {
    $('#set-theme').value = state.settings.theme;
    $('#set-currency').value = state.settings.currency;
  }

  // ============== Service worker ==============
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'sw-updated') {
          // soft refresh: reload once a new SW activates
          location.reload();
        }
      });
    });
  }

  // ============== Boot ==============
  (async function boot() {
    try {
      db = await openDB();
      await loadSettings();
      applyTheme();
      await loadAll();
      wire();
      initOnboarding();
      renderAll();
    } catch (e) {
      console.error(e);
      document.body.innerHTML = `<div style="padding:40px; font-family: -apple-system, sans-serif"><h1>pricewatch failed to start</h1><pre>${e.message}</pre></div>`;
    }
  })();
})();
