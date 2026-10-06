// ===================== PCOS — Point of Sale =====================
// All data is client-side. Bills persist in localStorage per browser.

const STORAGE_KEY = 'pcos_bills_v1';
const SALES_KEY = 'pcos_sales_history_v1';
const MAX_RESULTS = 60;

let products = [];          // loaded from products.json
let barcodeIndex = new Map(); // barcode -> product index
let codeIndex = new Map();    // exact code (lowercased) -> array of product indexes

let bills = [];            // [{id, name, items: {productIndex: qty}}]
let activeBillId = null;

let salesHistory = [];     // completed sales: {id, timestamp, billName, items:[{name,unit,qty,price,lineTotal}], totalQty, totalPrice}
let modalMode = null;      // 'checkout' | 'view'
let pendingRecord = null;
let currentRange = 'today';
let currentTable = 'bills';

// Thai Kedmanee keyboard: number-row unshifted output -> digit it represents.
// If the OS keyboard language is left on Thai, a barcode scanner (which just
// "types" the barcode) produces these characters instead of digits.
const THAI_TO_DIGIT = {
  'ๅ': '1', '/': '2', '-': '3', 'ภ': '4', 'ถ': '5',
  'ุ': '6', 'ึ': '7', 'ค': '8', 'ต': '9', 'จ': '0',
};

// Converts a string typed with the wrong keyboard language back into digits.
// Returns null if the string contains characters that don't map to a digit
// (i.e. it's not a mis-typed barcode).
function recoverDigits(str) {
  const s = str.trim();
  if (!s) return null;
  let out = '';
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') { out += ch; continue; }
    const mapped = THAI_TO_DIGIT[ch];
    if (!mapped) return null;
    out += mapped;
  }
  return out.length >= 6 ? out : null;
}

// ----- DOM references -----
const el = {
  scanInput: document.getElementById('scanInput'),
  clearSearch: document.getElementById('clearSearch'),
  results: document.getElementById('results'),
  emptyState: document.getElementById('emptyState'),
  productCount: document.getElementById('productCount'),
  billTabs: document.getElementById('billTabs'),
  newBillBtn: document.getElementById('newBillBtn'),
  cartTitle: document.getElementById('cartTitle'),
  renameBillBtn: document.getElementById('renameBillBtn'),
  cartLines: document.getElementById('cartLines'),
  cartEmpty: document.getElementById('cartEmpty'),
  summaryQty: document.getElementById('summaryQty'),
  summaryTotal: document.getElementById('summaryTotal'),
  clearBillBtn: document.getElementById('clearBillBtn'),
  checkoutBtn: document.getElementById('checkoutBtn'),
  modalBackdrop: document.getElementById('modalBackdrop'),
  receiptContent: document.getElementById('receiptContent'),
  modalCloseBtn: document.getElementById('modalCloseBtn'),
  printBtn: document.getElementById('printBtn'),
  confirmBackdrop: document.getElementById('confirmBackdrop'),
  confirmText: document.getElementById('confirmText'),
  confirmYes: document.getElementById('confirmYes'),
  confirmNo: document.getElementById('confirmNo'),
  clock: document.getElementById('clock'),
  posView: document.getElementById('posView'),
  dashboardView: document.getElementById('dashboardView'),
  viewButtons: document.querySelectorAll('.view-btn'),
  rangePicker: document.getElementById('rangePicker'),
  dashCards: document.getElementById('dashCards'),
  barChart: document.getElementById('barChart'),
  tableTabs: document.getElementById('tableTabs'),
  tableWrap: document.getElementById('tableWrap'),
  labelModalBackdrop: document.getElementById('labelModalBackdrop'),
  labelDrugName: document.getElementById('labelDrugName'),
  labelVerb: document.getElementById('labelVerb'),
  labelDoseAmount: document.getElementById('labelDoseAmount'),
  labelDoseUnit: document.getElementById('labelDoseUnit'),
  labelDoseUnitCustom: document.getElementById('labelDoseUnitCustom'),
  labelMeal: document.getElementById('labelMeal'),
  labelFrequency: document.getElementById('labelFrequency'),
  labelCustomHoursField: document.getElementById('labelCustomHoursField'),
  labelCustomHours: document.getElementById('labelCustomHours'),
  labelIndication: document.getElementById('labelIndication'),
  labelPatientName: document.getElementById('labelPatientName'),
  labelCopies: document.getElementById('labelCopies'),
  labelPreview: document.getElementById('labelPreview'),
  labelCloseBtn: document.getElementById('labelCloseBtn'),
  labelPrintBtn: document.getElementById('labelPrintBtn'),
  cameraScanBtn: document.getElementById('cameraScanBtn'),
  cameraModalBackdrop: document.getElementById('cameraModalBackdrop'),
  cameraVideo: document.getElementById('cameraVideo'),
  cameraStatus: document.getElementById('cameraStatus'),
  cameraCancelBtn: document.getElementById('cameraCancelBtn'),
};

// ===================== Init =====================

init();

async function init() {
  updateClock();
  setInterval(updateClock, 1000);

  loadBillsFromStorage();
  loadSalesHistory();
  if (bills.length === 0) {
    bills.push(makeBill('บิล 1'));
  }
  activeBillId = bills[0].id;

  renderTabs();
  renderCart();

  try {
    const res = await fetch('products.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    products = await res.json();
    buildIndexes();
    el.productCount.textContent = products.length.toLocaleString('th-TH');
  } catch (err) {
    el.emptyState.innerHTML = `<p style="color:#B84437">โหลดข้อมูลสินค้าไม่สำเร็จ<br><span style="font-size:0.8rem">ต้องเปิดผ่านเว็บเซิร์ฟเวอร์ (เช่น GitHub Pages หรือ localhost) — เปิดไฟล์ index.html ตรงๆ จะโหลด products.json ไม่ได้</span></p>`;
    console.error(err);
  }

  bindEvents();
}

function makeBill(name) {
  return { id: 'bill_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), name, items: {} };
}

// ===================== Product indexing & search =====================

function buildIndexes() {
  products.forEach((p, i) => {
    (p.barcodes || []).forEach(bc => {
      if (bc) barcodeIndex.set(bc, i);
    });
    const codeKey = String(p.code || '').toLowerCase();
    if (codeKey) {
      if (!codeIndex.has(codeKey)) codeIndex.set(codeKey, []);
      codeIndex.get(codeKey).push(i);
    }
  });
}

function findExactMatch(query) {
  const q = query.trim();
  if (!q) return null;
  if (barcodeIndex.has(q)) return [barcodeIndex.get(q)];
  const qLower = q.toLowerCase();
  if (codeIndex.has(qLower)) return codeIndex.get(qLower);

  // Was this typed while the keyboard language was set to Thai? Try to
  // recover the real digits and match again.
  const recovered = recoverDigits(q);
  if (recovered && recovered !== q) {
    if (barcodeIndex.has(recovered)) return [barcodeIndex.get(recovered)];
    if (codeIndex.has(recovered)) return codeIndex.get(recovered);
  }
  return null;
}

function searchProducts(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const name = String(p.name || '').toLowerCase();
    const code = String(p.code || '').toLowerCase();
    const bcHit = (p.barcodes || []).some(b => b.includes(q));
    if (name.includes(q) || code.includes(q) || bcHit) {
      matches.push(i);
      if (matches.length >= MAX_RESULTS) break;
    }
  }
  return matches;
}

// Shared lookup used by the Enter key, barcode-gun input, and the camera
// scanner: exact barcode/code match first (with Thai-keyboard recovery),
// then a fuzzy-search fallback.
function processScanValue(rawVal) {
  const val = String(rawVal).trim();
  if (!val) return;

  const looksMistyped = !/^[0-9-]+$/.test(val) && recoverDigits(val) !== null;

  const exact = findExactMatch(val);
  if (exact && exact.length === 1) {
    addToCart(exact[0], 1);
    el.scanInput.value = '';
    renderResults('');
    if (looksMistyped) {
      showToast('ตรวจพบว่าคีย์บอร์ดตั้งเป็นภาษาไทย ระบบแปลงบาร์โค้ดให้อัตโนมัติ — เปลี่ยนเป็น EN จะยิงได้เร็วขึ้น');
    }
    return;
  }
  if (exact && exact.length > 1) {
    // multiple units share this code — show them instead of guessing
    el.scanInput.value = val;
    renderResults(val);
    return;
  }
  // fall back to fuzzy search; if exactly one row shown, add it
  const idxs = searchProducts(val);
  if (idxs.length === 1) {
    addToCart(idxs[0], 1);
    el.scanInput.value = '';
    renderResults('');
  } else {
    el.scanInput.value = val;
    renderResults(val);
  }
}

// ===================== Rendering: search results =====================

function renderResults(query) {
  el.clearSearch.classList.toggle('visible', query.length > 0);

  if (!query.trim()) {
    el.results.innerHTML = '';
    el.results.appendChild(el.emptyState);
    return;
  }

  const idxs = searchProducts(query);

  if (idxs.length === 0) {
    el.results.innerHTML = `<div class="empty-state"><p>ไม่พบสินค้าที่ตรงกับ "${escapeHtml(query)}"</p></div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  idxs.forEach(i => frag.appendChild(renderProductRow(i)));

  el.results.innerHTML = '';
  el.results.appendChild(frag);

  if (idxs.length >= MAX_RESULTS) {
    const hint = document.createElement('div');
    hint.className = 'results-hint';
    hint.textContent = `แสดง ${MAX_RESULTS} รายการแรก — พิมพ์ให้เจาะจงขึ้นเพื่อจำกัดผลลัพธ์`;
    el.results.appendChild(hint);
  }
}

function renderProductRow(i) {
  const p = products[i];
  const row = document.createElement('div');
  row.className = 'product-row';
  row.innerHTML = `
    <div class="product-info">
      <div class="product-name">${escapeHtml(p.name)}</div>
      <div class="product-meta">รหัส ${escapeHtml(String(p.code || '-'))}${p.barcodes && p.barcodes.length ? ' · ' + escapeHtml(p.barcodes[0]) : ''}</div>
    </div>
    <div class="product-price">${formatMoney(p.price)}<span class="product-unit">${escapeHtml(p.unit || '')}</span></div>
  `;
  row.addEventListener('click', () => {
    addToCart(i, 1);
    el.scanInput.focus();
  });
  return row;
}

// ===================== Cart / bill logic =====================

function activeBill() {
  return bills.find(b => b.id === activeBillId);
}

function addToCart(index, qty) {
  const bill = activeBill();
  bill.items[index] = (bill.items[index] || 0) + qty;
  if (bill.items[index] <= 0) delete bill.items[index];
  saveBills();
  renderCart();
  renderTabs();
}

function setQty(index, qty) {
  const bill = activeBill();
  if (qty <= 0) {
    delete bill.items[index];
  } else {
    bill.items[index] = qty;
  }
  saveBills();
  renderCart();
  renderTabs();
}

function removeLine(index) {
  const bill = activeBill();
  delete bill.items[index];
  saveBills();
  renderCart();
  renderTabs();
}

function renderCart() {
  const bill = activeBill();
  if (!bill) return;

  el.cartTitle.textContent = bill.name;

  const entries = Object.entries(bill.items);
  el.cartLines.innerHTML = '';

  if (entries.length === 0) {
    el.cartLines.appendChild(el.cartEmpty);
  } else {
    const frag = document.createDocumentFragment();
    let totalQty = 0;
    let totalPrice = 0;

    entries.forEach(([idxStr, qty]) => {
      const idx = Number(idxStr);
      const p = products[idx];
      if (!p) return;
      totalQty += qty;
      const lineTotal = p.price * qty;
      totalPrice += lineTotal;

      const line = document.createElement('div');
      line.className = 'cart-line';
      line.innerHTML = `
        <div class="cl-info">
          <div class="cl-name">${escapeHtml(p.name)}</div>
          <div class="cl-unitprice">${formatMoney(p.price)} / ${escapeHtml(p.unit || '')}</div>
        </div>
        <div class="cl-qty">
          <button class="qty-btn" data-action="dec">−</button>
          <span class="qty-val">${qty}</span>
          <button class="qty-btn" data-action="inc">+</button>
        </div>
        <div class="cl-linetotal">${formatMoney(lineTotal)}</div>
        <button class="cl-label" title="พิมพ์ฉลากยา">
          <svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M11.5 3h-4a1 1 0 0 0-.7.3l-5 5a1 1 0 0 0 0 1.4l8.5 8.5a1 1 0 0 0 1.4 0l7.5-7.5a1 1 0 0 0 0-1.4l-6.7-6.6a1 1 0 0 0-.7-.3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="8.2" cy="8.2" r="1.3" fill="currentColor"/></svg>
        </button>
        <button class="cl-remove" title="ลบรายการ">🗑</button>
      `;
      line.querySelector('[data-action="inc"]').addEventListener('click', () => setQty(idx, qty + 1));
      line.querySelector('[data-action="dec"]').addEventListener('click', () => setQty(idx, qty - 1));
      line.querySelector('.cl-remove').addEventListener('click', () => removeLine(idx));
      line.querySelector('.cl-label').addEventListener('click', () => openLabelModal(idx, qty));
      frag.appendChild(line);
    });

    el.cartLines.appendChild(frag);
    el.summaryQty.textContent = totalQty.toLocaleString('th-TH');
    el.summaryTotal.textContent = formatMoney(totalPrice);
    el.checkoutBtn.disabled = false;
    return;
  }

  el.summaryQty.textContent = '0';
  el.summaryTotal.textContent = formatMoney(0);
  el.checkoutBtn.disabled = true;
}

// ===================== Bills / tabs (split bill) =====================

function renderTabs() {
  el.billTabs.innerHTML = '';
  bills.forEach(bill => {
    const count = Object.values(bill.items).reduce((a, b) => a + b, 0);
    const tab = document.createElement('div');
    tab.className = 'tab' + (bill.id === activeBillId ? ' active' : '');
    tab.innerHTML = `
      <span class="tab-name">${escapeHtml(bill.name)}</span>
      ${count > 0 ? `<span class="tab-badge">${count}</span>` : ''}
      ${bills.length > 1 ? `<span class="tab-close" title="ปิดบิลนี้">✕</span>` : ''}
    `;
    tab.querySelector('.tab-name').addEventListener('click', () => switchBill(bill.id));
    if (count > 0 || bills.length === 1) {
      tab.querySelector('.tab-badge')?.addEventListener('click', () => switchBill(bill.id));
    }
    const closeBtn = tab.querySelector('.tab-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        requestCloseBill(bill.id);
      });
    }
    el.billTabs.appendChild(tab);
  });
}

function switchBill(id) {
  activeBillId = id;
  renderTabs();
  renderCart();
  el.scanInput.value = '';
  renderResults('');
  el.scanInput.focus();
}

function newBill() {
  const nextNum = bills.length + 1;
  const bill = makeBill(`บิล ${nextNum}`);
  bills.push(bill);
  saveBills();
  switchBill(bill.id);
}

function requestCloseBill(id) {
  const bill = bills.find(b => b.id === id);
  const count = Object.values(bill.items).reduce((a, b) => a + b, 0);
  if (count > 0) {
    showConfirm(`บิล "${bill.name}" ยังมีสินค้าอยู่ ต้องการปิดบิลนี้ทิ้งหรือไม่?`, () => closeBill(id));
  } else {
    closeBill(id);
  }
}

function closeBill(id) {
  const idx = bills.findIndex(b => b.id === id);
  if (idx === -1) return;
  bills.splice(idx, 1);
  if (activeBillId === id) {
    activeBillId = bills[Math.max(0, idx - 1)].id;
  }
  saveBills();
  renderTabs();
  renderCart();
}

function renameBill() {
  const bill = activeBill();
  const name = prompt('ตั้งชื่อบิล:', bill.name);
  if (name && name.trim()) {
    bill.name = name.trim();
    saveBills();
    renderTabs();
    renderCart();
  }
}

// ===================== Checkout / receipt =====================

function checkout() {
  const bill = activeBill();
  const entries = Object.entries(bill.items);
  if (entries.length === 0) return;

  let totalQty = 0, totalPrice = 0;
  const items = entries.map(([idxStr, qty]) => {
    const p = products[Number(idxStr)];
    totalQty += qty;
    const lineTotal = p.price * qty;
    totalPrice += lineTotal;
    return { name: p.name, unit: p.unit || '', qty, price: p.price, lineTotal };
  });

  pendingRecord = {
    id: 'sale_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toISOString(),
    billName: bill.name,
    items,
    totalQty,
    totalPrice,
  };
  modalMode = 'checkout';
  renderReceipt(pendingRecord);
  el.modalBackdrop.classList.add('open');
}

function viewHistoryReceipt(record) {
  pendingRecord = record;
  modalMode = 'view';
  renderReceipt(record);
  el.modalBackdrop.classList.add('open');
}

function renderReceipt(record) {
  const rows = record.items.map(it =>
    `<tr><td>${escapeHtml(it.name)}</td><td>${it.qty} ${escapeHtml(it.unit || '')}</td><td>${formatMoney(it.lineTotal)}</td></tr>`
  ).join('');
  el.receiptContent.innerHTML = `
    <h3>ร้านยาถุงเงิน — ใบเสร็จ</h3>
    <div class="r-meta">${escapeHtml(record.billName)} · ${new Date(record.timestamp).toLocaleString('th-TH')}</div>
    <table>
      <thead><tr><th>รายการ</th><th>จำนวน</th><th>ราคา</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="2">รวมทั้งสิ้น (${record.totalQty} ชิ้น)</td><td>${formatMoney(record.totalPrice)}</td></tr></tfoot>
    </table>
  `;
}

function closeModal() {
  el.modalBackdrop.classList.remove('open');
  if (modalMode === 'checkout' && pendingRecord) {
    saveSaleRecord(pendingRecord);
    const bill = activeBill();
    bill.items = {};
    saveBills();
    renderCart();
    renderTabs();
    if (!el.dashboardView.hidden) renderDashboard();
  }
  modalMode = null;
  pendingRecord = null;
  el.scanInput.focus();
}

// ===================== Dashboard / sales reports =====================

function getRangeBounds(range) {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  switch (range) {
    case 'today':
      return { start: today, end: tomorrow };
    case '7d':
      return { start: addDays(today, -6), end: tomorrow };
    case '30d':
      return { start: addDays(today, -29), end: tomorrow };
    case 'month': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      const end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      return { start, end };
    }
    case 'all':
    default:
      return { start: null, end: null };
  }
}

function filterRecordsByRange(range) {
  const { start, end } = getRangeBounds(range);
  if (!start) return salesHistory.slice();
  return salesHistory.filter(r => {
    const t = new Date(r.timestamp);
    return t >= start && t < end;
  });
}

function switchView(view) {
  el.viewButtons.forEach(b => b.classList.toggle('active', b.dataset.view === view));
  el.posView.hidden = view !== 'pos';
  el.dashboardView.hidden = view !== 'dashboard';
  if (view === 'dashboard') renderDashboard();
  else el.scanInput.focus();
}

function setRange(range) {
  currentRange = range;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  renderDashboard();
}

function setTable(table) {
  currentTable = table;
  document.querySelectorAll('.ttab').forEach(b => b.classList.toggle('active', b.dataset.table === table));
  renderTableView();
}

function renderDashboard() {
  const records = filterRecordsByRange(currentRange);
  renderDashCards(records);
  renderBarChart(currentRange, records);
  renderTableView();
}

function renderDashCards(records) {
  const totalSales = records.reduce((s, r) => s + r.totalPrice, 0);
  const totalQty = records.reduce((s, r) => s + r.totalQty, 0);
  const billCount = records.length;
  const avg = billCount ? totalSales / billCount : 0;

  el.dashCards.innerHTML = `
    <div class="dash-card">
      <div class="dash-card-label">ยอดขายรวม</div>
      <div class="dash-card-value">${formatMoney(totalSales)}</div>
    </div>
    <div class="dash-card">
      <div class="dash-card-label">จำนวนบิลที่ปิดแล้ว</div>
      <div class="dash-card-value small">${billCount.toLocaleString('th-TH')} บิล</div>
    </div>
    <div class="dash-card">
      <div class="dash-card-label">จำนวนชิ้นที่ขาย</div>
      <div class="dash-card-value small">${totalQty.toLocaleString('th-TH')} ชิ้น</div>
    </div>
    <div class="dash-card">
      <div class="dash-card-label">เฉลี่ยต่อบิล</div>
      <div class="dash-card-value small">${formatMoney(avg)}</div>
    </div>
  `;
}

function renderBarChart(range, records) {
  const byDay = new Map(); // dayKey -> total
  records.forEach(r => {
    const k = dayKey(r.timestamp);
    byDay.set(k, (byDay.get(k) || 0) + r.totalPrice);
  });

  let days = [];
  const { start, end } = getRangeBounds(range);

  if (start) {
    let d = new Date(start);
    while (d < end) {
      days.push(new Date(d));
      d = addDays(d, 1);
    }
  } else {
    // 'all' — use only days that actually have sales, sorted ascending
    days = Array.from(byDay.keys()).sort().map(k => new Date(k + 'T00:00:00'));
    if (days.length > 60) days = days.slice(days.length - 60);
  }

  if (days.length === 0) {
    el.barChart.innerHTML = '<div class="bar-empty">ยังไม่มีข้อมูลการขายในช่วงนี้</div>';
    return;
  }

  const totals = days.map(d => byDay.get(dayKey(d)) || 0);
  const max = Math.max(...totals, 1);

  el.barChart.innerHTML = days.map((d, i) => {
    const heightPct = Math.max((totals[i] / max) * 100, totals[i] > 0 ? 3 : 0);
    const label = d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit' });
    return `
      <div class="bar-col" title="${label}: ${formatMoney(totals[i])}">
        <div class="bar" style="height:${heightPct}%"></div>
        <div class="bar-label">${label}</div>
      </div>
    `;
  }).join('');
}

function renderTableView() {
  const records = filterRecordsByRange(currentRange).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (currentTable === 'bills') {
    if (records.length === 0) {
      el.tableWrap.innerHTML = '<div class="table-empty">ยังไม่มีบิลที่ปิดแล้วในช่วงนี้</div>';
      return;
    }
    const rows = records.map(r => `
      <tr data-id="${r.id}">
        <td>${new Date(r.timestamp).toLocaleString('th-TH', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${escapeHtml(r.billName)}</td>
        <td>${r.totalQty} ชิ้น</td>
        <td>${formatMoney(r.totalPrice)}</td>
      </tr>
    `).join('');
    el.tableWrap.innerHTML = `
      <table class="data-table">
        <thead><tr><th>วันที่/เวลา</th><th>ชื่อบิล</th><th>จำนวน</th><th>ยอดรวม</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    el.tableWrap.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const rec = salesHistory.find(r => r.id === tr.dataset.id);
        if (rec) viewHistoryReceipt(rec);
      });
    });
  }

  if (currentTable === 'daily') {
    const byDay = new Map();
    records.forEach(r => {
      const k = dayKey(r.timestamp);
      if (!byDay.has(k)) byDay.set(k, { bills: 0, qty: 0, total: 0 });
      const agg = byDay.get(k);
      agg.bills += 1;
      agg.qty += r.totalQty;
      agg.total += r.totalPrice;
    });
    const keys = Array.from(byDay.keys()).sort().reverse();
    if (keys.length === 0) {
      el.tableWrap.innerHTML = '<div class="table-empty">ยังไม่มีข้อมูลในช่วงนี้</div>';
      return;
    }
    const rows = keys.map(k => {
      const agg = byDay.get(k);
      const label = new Date(k + 'T00:00:00').toLocaleDateString('th-TH', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
      return `<tr><td>${label}</td><td>${agg.bills} บิล</td><td>${agg.qty} ชิ้น</td><td>${formatMoney(agg.total)}</td></tr>`;
    }).join('');
    el.tableWrap.innerHTML = `
      <table class="data-table">
        <thead><tr><th>วันที่</th><th>จำนวนบิล</th><th>จำนวนชิ้น</th><th>ยอดรวม</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  if (currentTable === 'monthly') {
    const byMonth = new Map();
    records.forEach(r => {
      const k = monthKey(r.timestamp);
      if (!byMonth.has(k)) byMonth.set(k, { bills: 0, qty: 0, total: 0 });
      const agg = byMonth.get(k);
      agg.bills += 1;
      agg.qty += r.totalQty;
      agg.total += r.totalPrice;
    });
    const keys = Array.from(byMonth.keys()).sort().reverse();
    if (keys.length === 0) {
      el.tableWrap.innerHTML = '<div class="table-empty">ยังไม่มีข้อมูลในช่วงนี้</div>';
      return;
    }
    const rows = keys.map(k => {
      const agg = byMonth.get(k);
      const [y, m] = k.split('-');
      const label = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
      return `<tr><td>${label}</td><td>${agg.bills} บิล</td><td>${agg.qty} ชิ้น</td><td>${formatMoney(agg.total)}</td></tr>`;
    }).join('');
    el.tableWrap.innerHTML = `
      <table class="data-table">
        <thead><tr><th>เดือน</th><th>จำนวนบิล</th><th>จำนวนชิ้น</th><th>ยอดรวม</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }
}

// ===================== Drug label printing =====================

function openLabelModal(productIndex, qty) {
  const p = products[productIndex];
  if (!p) return;

  el.labelDrugName.value = p.name;
  el.labelVerb.value = 'รับประทาน';
  el.labelDoseAmount.value = 1;
  el.labelDoseUnit.value = 'เม็ด';
  el.labelDoseUnitCustom.value = '';
  el.labelDoseUnitCustom.classList.add('hidden-field');
  el.labelMeal.value = 'หลังอาหารทันที';
  el.labelFrequency.value = 'วันละ 2 ครั้ง';
  el.labelCustomHoursField.classList.add('hidden-field');
  el.labelCustomHours.value = 6;
  document.querySelectorAll('.labelTimeCk').forEach(ck => {
    ck.checked = (ck.value === 'เช้า' || ck.value === 'เย็น');
  });
  el.labelIndication.value = '';
  el.labelPatientName.value = '';
  el.labelCopies.value = qty && qty > 0 ? qty : 1;

  renderLabelPreview();
  el.labelModalBackdrop.classList.add('open');
}

function getLabelData() {
  const doseUnit = el.labelDoseUnit.value === '__custom'
    ? (el.labelDoseUnitCustom.value.trim() || 'หน่วย')
    : el.labelDoseUnit.value;

  const timeChecks = Array.from(document.querySelectorAll('.labelTimeCk'))
    .filter(ck => ck.checked)
    .map(ck => ck.value);
  // keep a fixed, natural order regardless of checkbox order in the DOM
  const order = ['เช้า', 'เที่ยง', 'เย็น', 'ก่อนนอน'];
  const timeText = order.filter(t => timeChecks.includes(t)).join('-');

  let freqText = el.labelFrequency.value;
  if (freqText === '__custom_hours') {
    const hrs = Number(el.labelCustomHours.value) || 6;
    freqText = `ทุก ${hrs} ชั่วโมง`;
  }

  return {
    drugName: el.labelDrugName.value.trim() || '(ไม่ระบุชื่อยา)',
    verb: el.labelVerb.value,
    doseAmount: el.labelDoseAmount.value,
    doseUnit,
    meal: el.labelMeal.value,
    freqText,
    timeText,
    indication: el.labelIndication.value.trim(),
    patientName: el.labelPatientName.value.trim(),
    copies: Math.max(1, Number(el.labelCopies.value) || 1),
  };
}

function buildLabelCardHTML(data) {
  const parts = [
    `${data.verb}ครั้งละ ${data.doseAmount} ${escapeHtml(data.doseUnit)}`,
    data.meal,
    data.freqText,
    data.timeText ? `เวลา ${data.timeText}` : '',
  ].filter(Boolean);
  const instruction = parts.join(' ');

  const now = new Date().toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: '2-digit' });

  return `
    <div class="label-card">
      <div class="label-shop">ร้านถุงเงินเภสัช<span class="label-shop-phone">098-549-2657</span></div>
      <div class="label-drugname">${escapeHtml(data.drugName)}</div>
      <div class="label-instruction">${escapeHtml(instruction)}</div>
      ${data.indication ? `<div class="label-indication">ข้อบ่งใช้: ${escapeHtml(data.indication)}</div>` : ''}
      <div class="label-meta">
        <span>${data.patientName ? 'ผู้ป่วย: ' + escapeHtml(data.patientName) : ''}</span>
        <span>${now}</span>
      </div>
      <div class="label-warning">เก็บให้พ้นมือเด็ก</div>
    </div>
  `;
}

function renderLabelPreview() {
  const data = getLabelData();
  el.labelPreview.innerHTML = buildLabelCardHTML(data);
}

function printLabel() {
  const data = getLabelData();
  const singleHtml = buildLabelCardHTML(data);
  const restore = () => {
    el.labelPreview.innerHTML = singleHtml;
    el.labelPreview.classList.remove('label-print-area');
    document.body.removeAttribute('data-printing');
    window.onafterprint = null;
  };

  el.labelPreview.innerHTML = Array(data.copies).fill(singleHtml).join('');
  document.body.setAttribute('data-printing', 'label');
  window.onafterprint = restore;
  window.print();
  // fallback in case onafterprint doesn't fire (e.g. some mobile browsers)
  setTimeout(restore, 1500);
}

// ===================== Camera barcode scanning =====================
// Uses the phone/webcam camera to read barcodes, via the ZXing library
// (loaded lazily from a CDN only when the feature is first used, so the
// core POS flow keeps working fully offline).

let zxingReader = null;
let cameraScanControls = null;
let cameraScanLocked = false;

function loadZXing() {
  if (window.ZXing) return Promise.resolve();
  if (loadZXing._promise) return loadZXing._promise;
  loadZXing._promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/@zxing/library@latest/umd/index.min.js';
    script.onload = () => resolve();
    script.onerror = () => {
      loadZXing._promise = null;
      reject(new Error('โหลดไลบรารีสแกนบาร์โค้ดไม่สำเร็จ'));
    };
    document.head.appendChild(script);
  });
  return loadZXing._promise;
}

function setCameraStatus(text, isError) {
  el.cameraStatus.textContent = text;
  el.cameraStatus.classList.toggle('error', !!isError);
}

async function openCameraScan() {
  cameraScanLocked = false;
  el.cameraModalBackdrop.classList.add('open');
  setCameraStatus('กำลังโหลดระบบสแกน...', false);

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setCameraStatus('เบราว์เซอร์นี้ไม่รองรับกล้อง หรือหน้านี้ไม่ได้เปิดผ่าน HTTPS', true);
    return;
  }

  try {
    await loadZXing();
  } catch (err) {
    setCameraStatus('โหลดระบบสแกนไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่', true);
    return;
  }

  setCameraStatus('กำลังเปิดกล้อง...', false);
  try {
    zxingReader = zxingReader || new window.ZXing.BrowserMultiFormatReader();
    cameraScanControls = await zxingReader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } } },
      el.cameraVideo,
      (result) => {
        if (result && !cameraScanLocked) {
          cameraScanLocked = true;
          handleCameraScanResult(result.getText());
        }
        // decode errors (NotFoundException) fire continuously while no
        // barcode is in view — that's normal and safely ignored here.
      }
    );
    setCameraStatus('เล็งกล้องไปที่บาร์โค้ดสินค้า');
  } catch (err) {
    console.error(err);
    setCameraStatus('เปิดกล้องไม่สำเร็จ: กรุณาอนุญาตให้ใช้กล้อง แล้วลองใหม่', true);
  }
}

function stopCameraScan() {
  try { cameraScanControls && cameraScanControls.stop(); } catch (e) { /* noop */ }
  try { zxingReader && zxingReader.reset(); } catch (e) { /* noop */ }
  cameraScanControls = null;
}

function closeCameraModal() {
  stopCameraScan();
  el.cameraModalBackdrop.classList.remove('open');
}

function handleCameraScanResult(text) {
  stopCameraScan();
  el.cameraModalBackdrop.classList.remove('open');
  processScanValue(text);
}

// ===================== Persistence =====================

function saveBills() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ bills, activeBillId }));
}

function loadBillsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.bills) && data.bills.length > 0) {
      bills = data.bills;
      activeBillId = data.activeBillId || bills[0].id;
    }
  } catch (e) {
    console.warn('ไม่สามารถโหลดข้อมูลบิลจาก localStorage', e);
  }
}

function loadSalesHistory() {
  try {
    const raw = localStorage.getItem(SALES_KEY);
    salesHistory = raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('ไม่สามารถโหลดประวัติการขาย', e);
    salesHistory = [];
  }
}

function saveSaleRecord(record) {
  salesHistory.push(record);
  localStorage.setItem(SALES_KEY, JSON.stringify(salesHistory));
}

// ===================== Confirm dialog helper =====================

let confirmCallback = null;
function showConfirm(text, onYes) {
  el.confirmText.textContent = text;
  confirmCallback = onYes;
  el.confirmBackdrop.classList.add('open');
}

// ===================== Utilities =====================

function formatMoney(n) {
  return (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' บาท';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function dayKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function monthKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}
function startOfDay(d) {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
function addDays(d, n) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + n);
  return dt;
}

function updateClock() {
  const now = new Date();
  el.clock.textContent = now.toLocaleString('th-TH', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit'
  });
}

let toastTimer = null;
function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

// ===================== Event bindings =====================

function bindEvents() {
  let debounceTimer;
  el.scanInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderResults(el.scanInput.value), 80);
  });

  el.scanInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    processScanValue(el.scanInput.value);
  });

  el.clearSearch.addEventListener('click', () => {
    el.scanInput.value = '';
    renderResults('');
    el.scanInput.focus();
  });

  el.cameraScanBtn.addEventListener('click', openCameraScan);
  el.cameraCancelBtn.addEventListener('click', closeCameraModal);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && el.cameraModalBackdrop.classList.contains('open')) {
      closeCameraModal();
    }
  });

  el.newBillBtn.addEventListener('click', newBill);
  el.renameBillBtn.addEventListener('click', renameBill);

  el.clearBillBtn.addEventListener('click', () => {
    const bill = activeBill();
    const count = Object.values(bill.items).reduce((a, b) => a + b, 0);
    if (count === 0) return;
    showConfirm(`ล้างสินค้าทั้งหมดในบิล "${bill.name}" หรือไม่?`, () => {
      bill.items = {};
      saveBills();
      renderCart();
      renderTabs();
    });
  });

  el.checkoutBtn.addEventListener('click', checkout);
  el.modalCloseBtn.addEventListener('click', closeModal);
  el.printBtn.addEventListener('click', () => {
    document.body.setAttribute('data-printing', 'receipt');
    window.print();
    document.body.removeAttribute('data-printing');
    closeModal();
  });

  // ---- Drug label modal ----
  el.labelCloseBtn.addEventListener('click', () => {
    el.labelModalBackdrop.classList.remove('open');
  });
  el.labelPrintBtn.addEventListener('click', printLabel);

  el.labelDoseUnit.addEventListener('change', () => {
    el.labelDoseUnitCustom.classList.toggle('hidden-field', el.labelDoseUnit.value !== '__custom');
    renderLabelPreview();
  });
  el.labelFrequency.addEventListener('change', () => {
    el.labelCustomHoursField.classList.toggle('hidden-field', el.labelFrequency.value !== '__custom_hours');
    renderLabelPreview();
  });
  [
    el.labelDrugName, el.labelVerb, el.labelDoseAmount, el.labelDoseUnitCustom,
    el.labelMeal, el.labelCustomHours, el.labelIndication, el.labelPatientName, el.labelCopies,
  ].forEach(field => field.addEventListener('input', renderLabelPreview));
  document.querySelectorAll('.labelTimeCk').forEach(ck => ck.addEventListener('change', renderLabelPreview));

  el.viewButtons.forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  el.rangePicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (btn) setRange(btn.dataset.range);
  });

  el.tableTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.ttab');
    if (btn) setTable(btn.dataset.table);
  });

  el.confirmYes.addEventListener('click', () => {
    el.confirmBackdrop.classList.remove('open');
    if (confirmCallback) confirmCallback();
    confirmCallback = null;
  });
  el.confirmNo.addEventListener('click', () => {
    el.confirmBackdrop.classList.remove('open');
    confirmCallback = null;
  });

  // Keep the scan input focused for barcode-gun workflows (POS view only)
  document.addEventListener('click', (e) => {
    if (el.posView.hidden) return;
    if (e.target.closest('.modal, input, button, .tab')) return;
    el.scanInput.focus();
  });
}
