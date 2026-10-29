// PrintPilot Admin Dashboard Controller — Feeds and manages PostgreSQL (Relational + JSONB) datasets.

const $ = (s) => document.querySelector(s);

let state = {
  products: [],
  capabilities: [],
  hrjJobs: [],
  dnpObs: [],
  route1Rows: [],
  bands: [],
  postcodes: {},
  config: null,
  editingProduct: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

function toast(msg, type = 'ok') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.display = 'none';
  }, 3400);
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  const pane = document.getElementById('tab-' + tabId);
  if (pane) pane.classList.add('active');
  const navBtn = document.querySelector(`.nav-btn[data-tab="${tabId}"]`);
  if (navBtn) navBtn.classList.add('active');
}

async function loadAllAdminData() {
  try {
    const [summaryRes, hrjRes, dnpRes, r1Res, bandsRes, pcRes] = await Promise.all([
      fetch('/api/admin/summary'),
      fetch('/api/data/hrj-jobs'),
      fetch('/api/data/dnp-selling'),
      fetch('/api/data/route1-prices'),
      fetch('/api/data/distance-bands'),
      fetch('/api/data/postcodes'),
    ]);

    const summary = await summaryRes.json();
    state.products = summary.products || [];
    state.capabilities = summary.capabilities || [];
    state.config = summary.config || null;
    state.hrjJobs = await hrjRes.json();
    state.dnpObs = await dnpRes.json();
    state.route1Rows = await r1Res.json();
    state.bands = await bandsRes.json();
    state.postcodes = await pcRes.json();

    renderAll();
  } catch (err) {
    console.error(err);
    toast('Failed to load admin data: ' + err.message, 'err');
  }
}

function renderAll() {
  // Counts & KPIs
  $('#cntProducts').textContent = state.products.length;
  $('#cntCapabilities').textContent = state.capabilities.length;
  $('#cntHrj').textContent = state.hrjJobs.length;
  $('#cntDnp').textContent = state.dnpObs.length;
  $('#cntRoute1').textContent = state.route1Rows.length;
  $('#cntPostcodes').textContent = Object.keys(state.postcodes).length;

  $('#kpiProducts').textContent = state.products.length;
  $('#kpiHrj').textContent = state.hrjJobs.length;
  $('#kpiDnp').textContent = state.dnpObs.length;
  $('#kpiRoute1').textContent = state.route1Rows.length;

  renderOverviewTable();
  populateProductDropdowns();
  if (!state.editingProduct && state.products.length > 0) {
    selectProductForEdit(state.products[0].id);
  } else if (state.editingProduct) {
    selectProductForEdit(state.editingProduct.id);
  }
  renderCapabilitiesTable();
  renderHrjTable();
  renderDnpTable();
  renderRoute1Table();
  renderLogisticsTables();
  renderBusinessConfigForm();
}

function renderOverviewTable() {
  const tbody = $('#overviewProductsTable');
  tbody.innerHTML = state.products
    .map(
      (p) => `
    <tr>
      <td><code>${esc(p.id)}</code></td>
      <td><strong>${esc(p.name)}</strong></td>
      <td>${esc(p.category)}</td>
      <td><span class="badge ${p.vatRate > 0 ? 'warn' : 'ok'}">${Math.round(p.vatRate * 100)}% VAT</span></td>
      <td>${(p.attributes || []).map((a) => `<span class="badge">${esc(a.attributeKey)}</span>`).join(' ')}</td>
      <td style="color:#667085;font-size:12px">${esc((p.keywords || []).slice(0, 6).join(', '))}</td>
      <td>
        <button class="btn sm" onclick="switchTab('products');selectProductForEdit('${esc(p.id)}')">Edit Schema</button>
      </td>
    </tr>`
    )
    .join('');
}

function populateProductDropdowns() {
  const opts = state.products
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`)
    .join('');
  ['productSelector', 'capProductId', 'hrjProductId', 'dnpProductId', 'r1ProductId'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
}

// ---- PRODUCTS & DYNAMIC ATTRIBUTES ----

function selectProductForEdit(productId) {
  const prod = state.products.find((p) => p.id === productId);
  if (!prod) return;
  state.editingProduct = structuredClone(prod);
  $('#productSelector').value = prod.id;
  $('#prodFormTitle').textContent = `Edit Product: ${prod.name}`;
  populateProductForm(state.editingProduct);
}

function initNewProductForm() {
  state.editingProduct = {
    id: '',
    name: '',
    singularName: '',
    category: 'Commercial Print',
    vatRate: 0.2,
    active: true,
    defaultPaper: 'Silk',
    keywords: [],
    stockRecommendation: null,
    rfcModelConfig: {
      baseExpectedHours: 3.0,
      minExpectedHours: 2.0,
      a4AdderHours: 0.25,
      p80AnchorHours: 6.0,
      p80BlendWeight: 0.35,
    },
    pricingConfig: {
      standardThresholdHours: 72,
      standardDeliveryAllowance: 15,
      protectedCostFloorMultiplier: 2,
      quoteRoundingStep: 5,
      compressionRoundingStep: 25,
      deadlineCompressionPoints: [
        [0, 600],
        [4, 400],
        [6, 250],
        [8, 150],
        [12, 75],
        [18, 0],
        [23, 0],
      ],
    },
    attributes: [
      {
        productId: '',
        attributeKey: 'size',
        label: 'Finished size',
        inputType: 'select',
        wideInput: false,
        sortOrder: 1,
        required: true,
        questionPrompt: 'What finished size do you need?',
        validationRules: { allowedValues: ['A5', 'A4'] },
        quickChoices: [
          { label: 'A5', value: 'A5' },
          { label: 'A4', value: 'A4' },
        ],
      },
    ],
  };
  $('#prodFormTitle').textContent = 'Create New Product Definition';
  populateProductForm(state.editingProduct);
}

function populateProductForm(p) {
  $('#prodId').value = p.id || '';
  $('#prodName').value = p.name || '';
  $('#prodSingular').value = p.singularName || '';
  $('#prodCategory').value = p.category || '';
  $('#prodVat').value = p.vatRate ?? 0;
  $('#prodPaper').value = p.defaultPaper || '';
  $('#prodKeywords').value = (p.keywords || []).join(', ');

  $('#prodRfcBase').value = p.rfcModelConfig?.baseExpectedHours ?? 3.5;
  $('#prodRfcMin').value = p.rfcModelConfig?.minExpectedHours ?? 2.0;
  $('#prodRfcP80').value = p.rfcModelConfig?.p80AnchorHours ?? 6.5;

  $('#prodStdHours').value = p.pricingConfig?.standardThresholdHours ?? 72;
  $('#prodStdDel').value = p.pricingConfig?.standardDeliveryAllowance ?? 18;
  $('#prodFloorMult').value = p.pricingConfig?.protectedCostFloorMultiplier ?? 2;

  renderAttributeRows();
}

function renderAttributeRows() {
  const container = $('#productAttributesContainer');
  const attrs = state.editingProduct?.attributes || [];
  container.innerHTML = attrs
    .map((a, idx) => {
      const allowedStr = (a.validationRules?.allowedValues || []).join(', ');
      const choicesStr = (a.quickChoices || []).map((c) => `${c.label}:${c.value}`).join(', ');
      return `
      <div class="attr-item">
        <div class="attr-item-head">
          <strong>Attribute #${idx + 1} (${esc(a.attributeKey || 'new')})</strong>
          <button class="btn danger sm" type="button" onclick="removeAttributeRow(${idx})">Remove</button>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>Attribute Key (JSONB key)</label>
            <input data-attr-idx="${idx}" data-attr-field="attributeKey" value="${esc(a.attributeKey)}" placeholder="e.g. sides">
          </div>
          <div class="form-group">
            <label>Sidebar Label</label>
            <input data-attr-idx="${idx}" data-attr-field="label" value="${esc(a.label)}" placeholder="e.g. Printed sides">
          </div>
          <div class="form-group">
            <label>Input Type</label>
            <select data-attr-idx="${idx}" data-attr-field="inputType">
              <option value="select" ${a.inputType === 'select' ? 'selected' : ''}>select (Dropdown)</option>
              <option value="number" ${a.inputType === 'number' ? 'selected' : ''}>number</option>
              <option value="text" ${a.inputType === 'text' ? 'selected' : ''}>text</option>
            </select>
          </div>
          <div class="form-group full">
            <label>Conversational Bot Question Prompt (HTML allowed)</label>
            <input data-attr-idx="${idx}" data-attr-field="questionPrompt" value="${esc(a.questionPrompt)}">
          </div>
          <div class="form-group">
            <label>Allowed Values (comma-separated for select)</label>
            <input data-attr-idx="${idx}" data-attr-field="allowedValues" value="${esc(allowedStr)}" placeholder="e.g. Single-sided, Double-sided">
          </div>
          <div class="form-group">
            <label>Quick Choice Buttons (Label:Value, comma-separated)</label>
            <input data-attr-idx="${idx}" data-attr-field="quickChoices" value="${esc(choicesStr)}" placeholder="e.g. A5:A5, A4:A4">
          </div>
          <div class="form-group">
            <label>Composite Group (optional, e.g. stock)</label>
            <input data-attr-idx="${idx}" data-attr-field="compositeGroup" value="${esc(a.compositeGroup || '')}">
          </div>
        </div>
      </div>`;
    })
    .join('');
}

function syncAttributeDomToState() {
  if (!state.editingProduct) return;
  const attrs = state.editingProduct.attributes || [];
  document.querySelectorAll('[data-attr-idx]').forEach((el) => {
    const idx = Number(el.dataset.attrIdx);
    const field = el.dataset.attrField;
    if (!attrs[idx]) return;
    if (field === 'allowedValues') {
      const vals = el.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      attrs[idx].validationRules = { ...(attrs[idx].validationRules || {}), allowedValues: vals };
    } else if (field === 'quickChoices') {
      attrs[idx].quickChoices = el.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pair) => {
          const [lbl, val] = pair.split(':').map((x) => x.trim());
          const num = Number(val ?? lbl);
          return {
            label: lbl,
            value: !Number.isNaN(num) && String(num) === (val ?? lbl) ? num : val ?? lbl,
          };
        });
    } else if (field === 'compositeGroup') {
      attrs[idx].compositeGroup = el.value.trim() || undefined;
    } else {
      attrs[idx][field] = el.value;
    }
  });
}

function addAttributeRow() {
  syncAttributeDomToState();
  if (!state.editingProduct) initNewProductForm();
  state.editingProduct.attributes.push({
    productId: $('#prodId').value.trim(),
    attributeKey: 'custom_attr',
    label: 'Custom Attribute',
    inputType: 'select',
    wideInput: true,
    sortOrder: state.editingProduct.attributes.length + 1,
    required: true,
    questionPrompt: 'Which option would you like?',
    validationRules: { allowedValues: ['Option A', 'Option B'] },
    quickChoices: [
      { label: 'Option A', value: 'Option A' },
      { label: 'Option B', value: 'Option B' },
    ],
  });
  renderAttributeRows();
}

function removeAttributeRow(idx) {
  syncAttributeDomToState();
  state.editingProduct.attributes.splice(idx, 1);
  renderAttributeRows();
}

async function saveProductForm() {
  try {
    syncAttributeDomToState();
    const id = $('#prodId').value.trim();
    const name = $('#prodName').value.trim();
    if (!id || !name) {
      toast('Product ID and Plural Name are required', 'err');
      return;
    }

    const payload = {
      ...state.editingProduct,
      id,
      name,
      singularName: $('#prodSingular').value.trim() || name,
      category: $('#prodCategory').value.trim() || 'Print',
      vatRate: Number($('#prodVat').value || 0),
      active: true,
      defaultPaper: $('#prodPaper').value.trim() || 'Silk',
      keywords: $('#prodKeywords')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      rfcModelConfig: {
        ...(state.editingProduct?.rfcModelConfig || {}),
        baseExpectedHours: Number($('#prodRfcBase').value || 3.5),
        minExpectedHours: Number($('#prodRfcMin').value || 2.0),
        a4AdderHours: state.editingProduct?.rfcModelConfig?.a4AdderHours ?? 0.25,
        p80AnchorHours: Number($('#prodRfcP80').value || 6.5),
        p80BlendWeight: state.editingProduct?.rfcModelConfig?.p80BlendWeight ?? 0.35,
      },
      pricingConfig: {
        ...(state.editingProduct?.pricingConfig || {}),
        standardThresholdHours: Number($('#prodStdHours').value || 72),
        standardDeliveryAllowance: Number($('#prodStdDel').value || 18),
        protectedCostFloorMultiplier: Number($('#prodFloorMult').value || 2),
        quoteRoundingStep: 5,
        compressionRoundingStep: 25,
        deadlineCompressionPoints: state.editingProduct?.pricingConfig?.deadlineCompressionPoints || [
          [0, 600],
          [12, 100],
          [23, 0],
        ],
      },
      attributes: (state.editingProduct?.attributes || []).map((a, i) => ({
        ...a,
        productId: id,
        sortOrder: i + 1,
      })),
    };

    const res = await fetch('/api/data/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to save product');
    toast(`Saved product "${name}" to PostgreSQL`);
    await loadAllAdminData();
    selectProductForEdit(id);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---- SUPPLIER CAPABILITIES ----

function renderCapabilitiesTable() {
  const tbody = $('#capabilitiesTable');
  tbody.innerHTML = state.capabilities
    .map(
      (c, i) => `
    <tr>
      <td><strong>${esc(c.supplierName)}</strong> (<code>${esc(c.supplierId)}</code>)</td>
      <td><code>${esc(c.productId)}</code></td>
      <td><span class="badge ok">${c.supported ? 'Yes' : 'No'}</span></td>
      <td style="font-size:12px">${(c.quantityLimitsByHours || [])
        .map((t) => `≤${t.maxHours}h: max ${t.maxQty}`)
        .join(' · ') || 'Default'}</td>
      <td style="font-size:12px">${
        (c.excludedCombinations || []).length
          ? c.excludedCombinations.map((e) => esc(JSON.stringify(e.attributes))).join(', ')
          : 'None'
      }</td>
      <td><button class="btn sm" onclick="loadCapabilityIntoForm(${i})">Load into Editor</button></td>
    </tr>`
    )
    .join('');
}

function loadCapabilityIntoForm(idx) {
  const c = state.capabilities[idx];
  if (!c) return;
  $('#capSupplierId').value = c.supplierId;
  $('#capSupplierName').value = c.supplierName;
  $('#capProductId').value = c.productId;
  $('#capDefaultChoices').value = (c.defaultQuantityChoices || []).join(', ');
  $('#capQtyLimits').value = JSON.stringify(c.quantityLimitsByHours || [], null, 2);
  $('#capExclusions').value = JSON.stringify(c.excludedCombinations || [], null, 2);
}

async function saveSupplierCapability() {
  try {
    const payload = {
      supplierId: $('#capSupplierId').value.trim(),
      supplierName: $('#capSupplierName').value.trim(),
      productId: $('#capProductId').value,
      supported: true,
      defaultQuantityChoices: $('#capDefaultChoices')
        .value.split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
      quantityLimitsByHours: JSON.parse($('#capQtyLimits').value || '[]'),
      excludedCombinations: JSON.parse($('#capExclusions').value || '[]'),
    };
    const res = await fetch('/api/data/supplier-capabilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to save supplier capability');
    toast('Supplier capability saved');
    await loadAllAdminData();
  } catch (err) {
    toast('Invalid capability JSON or request: ' + err.message, 'err');
  }
}

// ---- HRJ HISTORICAL JOBS ----

function renderHrjTable() {
  $('#hrjCountLabel').textContent = state.hrjJobs.length;
  const tbody = $('#hrjTable');
  tbody.innerHTML = state.hrjJobs
    .slice()
    .reverse()
    .map(
      (j) => `
    <tr>
      <td><strong>#${esc(j.order_id)}</strong></td>
      <td><code>${esc(j.product_id || 'saddle-stitched-booklets')}</code></td>
      <td><span class="badge">${esc(j.source)}</span></td>
      <td>${j.qty}</td>
      <td>${esc(j.size2)}</td>
      <td>${j.pages}pp</td>
      <td>${j.hours_to_deadline != null ? Number(j.hours_to_deadline).toFixed(1) + 'h' : '—'}</td>
      <td><strong>£${Number(j.vendor_due).toFixed(2)}</strong></td>
      <td style="color:#667085;font-size:12px">${esc(j.paid_at)}</td>
      <td><button class="btn danger sm" onclick="deleteHrjJob('${esc(j.order_id)}')">Delete</button></td>
    </tr>`
    )
    .join('');
}

async function addHrjJob() {
  try {
    const orderId = $('#hrjOrderId').value.trim();
    const vendorDue = Number($('#hrjVendorDue').value);
    const qty = Number($('#hrjQty').value);
    if (!orderId || !vendorDue || !qty) {
      toast('Order ID, HRJ Settlement (£), and Quantity are required', 'err');
      return;
    }
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const payload = {
      order_id: orderId,
      product_id: $('#hrjProductId').value,
      vendor_due: vendorDue,
      qty,
      size2: $('#hrjSize').value.trim() || 'A4',
      pages: Number($('#hrjPages').value || 16),
      hours_to_deadline: Number($('#hrjHours').value || 16),
      paid_at: nowStr,
      source: $('#hrjSource').value,
      urgency_reliable: $('#hrjReliable').value === 'true',
    };
    const res = await fetch('/api/data/hrj-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to add HRJ job');
    $('#hrjOrderId').value = '';
    toast(`Added HRJ historical job #${orderId}`);
    await loadAllAdminData();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteHrjJob(orderId) {
  try {
    const res = await fetch(`/api/data/hrj-jobs/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete HRJ job');
    toast(`Deleted HRJ job #${orderId}`);
    await loadAllAdminData();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---- DNP SELLING OBSERVATIONS ----

function renderDnpTable() {
  $('#dnpCountLabel').textContent = state.dnpObs.length;
  const tbody = $('#dnpTable');
  tbody.innerHTML = state.dnpObs
    .slice()
    .reverse()
    .map(
      (o) => `
    <tr>
      <td><strong>#${esc(o.id)}</strong></td>
      <td><code>${esc(o.product_id || 'saddle-stitched-booklets')}</code></td>
      <td><span class="badge">${esc(o.source)}</span></td>
      <td>${o.qty}</td>
      <td>${esc(o.size2)}</td>
      <td>${o.pages}pp</td>
      <td><strong>£${Number(o.sell).toFixed(2)}</strong></td>
      <td>£${Number(o.vendor_due).toFixed(2)}</td>
      <td>${o.hours_to_deadline != null ? Number(o.hours_to_deadline).toFixed(1) + 'h' : '—'}</td>
      <td><button class="btn danger sm" onclick="deleteDnpObs('${esc(o.id)}')">Delete</button></td>
    </tr>`
    )
    .join('');
}

async function addDnpObservation() {
  try {
    const id = $('#dnpId').value.trim();
    const sell = Number($('#dnpSell').value);
    const qty = Number($('#dnpQty').value);
    if (!id || !sell || !qty) {
      toast('Order ID, Customer Selling Price (£), and Quantity are required', 'err');
      return;
    }
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const payload = {
      id,
      product_id: $('#dnpProductId').value,
      source: $('#dnpSource').value,
      qty,
      size2: $('#dnpSize').value.trim() || 'A4',
      pages: Number($('#dnpPages').value || 16),
      sell,
      vendor_due: Number($('#dnpVendorDue').value || 100),
      paid_at: nowStr,
      hours_to_deadline: Number($('#dnpHours').value || 16),
      urgency_reliable: true,
    };
    const res = await fetch('/api/data/dnp-selling', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to add DNP selling observation');
    $('#dnpId').value = '';
    toast(`Added DNP selling record #${id}`);
    await loadAllAdminData();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteDnpObs(id) {
  try {
    const res = await fetch(`/api/data/dnp-selling/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete observation');
    toast(`Deleted selling record #${id}`);
    await loadAllAdminData();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---- ROUTE1 STANDARD TARIFF ----

function renderRoute1Table() {
  $('#r1CountLabel').textContent = state.route1Rows.length;
  const q = ($('#r1Filter')?.value || '').toLowerCase().trim();
  const filtered = state.route1Rows
    .filter((r) => !q || `${r.productId} ${r.size} ${r.quantity} ${r.pages}`.toLowerCase().includes(q))
    .slice(0, 80);

  $('#route1Table').innerHTML = filtered
    .map(
      (r) => `
    <tr>
      <td><code>${esc(r.productId || 'saddle-stitched-booklets')}</code></td>
      <td><strong>${esc(r.size)}</strong></td>
      <td>${r.quantity}</td>
      <td>${r.pages}pp</td>
      <td><strong>£${Number(r.price).toFixed(2)}</strong></td>
    </tr>`
    )
    .join('');
}

async function addRoute1PriceRow() {
  try {
    const payload = {
      productId: $('#r1ProductId').value,
      size: $('#r1Size').value.trim(),
      quantity: Number($('#r1Qty').value),
      pages: Number($('#r1Pages').value || 8),
      price: Number($('#r1Price').value),
    };
    if (!payload.size || !payload.quantity || !payload.price) {
      toast('Size, Quantity, and Price are required', 'err');
      return;
    }
    const res = await fetch('/api/data/route1-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to upsert Route1 row');
    toast(`Saved Route1 tariff row (${payload.size}, ${payload.quantity} copies)`);
    await loadAllAdminData();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---- LOGISTICS & POSTCODES ----

function renderLogisticsTables() {
  const pcEntries = Object.entries(state.postcodes);
  $('#postcodesTable').innerHTML = pcEntries
    .map(
      ([pc, info]) => `
    <tr>
      <td><strong><code>${esc(pc)}</code></strong></td>
      <td><strong>${Number(info.miles).toFixed(1)} miles</strong></td>
      <td style="color:#667085">${esc(info.source)}</td>
    </tr>`
    )
    .join('');

  $('#bandsTable').innerHTML = state.bands
    .map(
      (b, idx) => `
    <tr>
      <td><input data-band-idx="${idx}" data-band-field="label" value="${esc(b.label)}" style="width:110px;padding:6px;border:1px solid #d0d5dd;border-radius:6px"></td>
      <td><input data-band-idx="${idx}" data-band-field="max" type="number" step="1" value="${b.max}" style="width:90px;padding:6px;border:1px solid #d0d5dd;border-radius:6px"></td>
      <td><input data-band-idx="${idx}" data-band-field="gophr" type="number" step="0.01" value="${b.gophr}" style="width:100px;padding:6px;border:1px solid #d0d5dd;border-radius:6px"></td>
      <td><input data-band-idx="${idx}" data-band-field="dnp" type="number" step="0.01" value="${b.dnp}" style="width:100px;padding:6px;border:1px solid #d0d5dd;border-radius:6px"></td>
      <td><input data-band-idx="${idx}" data-band-field="operationalBufferHours" type="number" step="0.01" value="${b.operationalBufferHours}" style="width:100px;padding:6px;border:1px solid #d0d5dd;border-radius:6px"></td>
    </tr>`
    )
    .join('');
}

async function addPostcodeDistance() {
  try {
    const postcode = $('#pcCode').value.trim();
    const miles = Number($('#pcMiles').value);
    const source = $('#pcSource').value.trim();
    if (!postcode || !Number.isFinite(miles)) {
      toast('Postcode and numeric miles are required', 'err');
      return;
    }
    const res = await fetch('/api/data/postcodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcode, miles, source }),
    });
    if (!res.ok) throw new Error('Failed to save postcode');
    $('#pcCode').value = '';
    $('#pcMiles').value = '';
    toast(`Saved verified road distance for ${postcode.toUpperCase()}`);
    await loadAllAdminData();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveDistanceBands() {
  try {
    const updatedBands = state.bands.map((b) => ({ ...b }));
    document.querySelectorAll('[data-band-idx]').forEach((el) => {
      const idx = Number(el.dataset.bandIdx);
      const field = el.dataset.bandField;
      updatedBands[idx][field] = field === 'label' ? el.value : Number(el.value);
    });
    const res = await fetch('/api/data/distance-bands', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedBands),
    });
    if (!res.ok) throw new Error('Failed to update distance bands');
    toast('Saved courier distance bands');
    await loadAllAdminData();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---- GLOBAL BUSINESS CONFIG ----

function renderBusinessConfigForm() {
  const c = state.config;
  if (!c) return;
  $('#cfgPeCutoff').value = c.printedEasy?.customerCutoffMinutes ?? 930;
  $('#cfgPeOrderCutoff').value = c.printedEasy?.orderCutoffMinutes ?? 960;
  $('#cfgHrjOrigin').value = c.hrjRouting?.originAddress ?? '';
  $('#cfgHrjSafeHour').value = c.hrjRouting?.safeNextDayDeliveryHour ?? 13;
  $('#cfgHrjMinEarly').value = c.hrjRouting?.minHoursEarlyTomorrow ?? 8;
  $('#cfgHrjMinDirect').value = c.hrjRouting?.minHoursDirect ?? 4;

  $('#cfgOohSurcharge').value = c.courierRules?.dnpOohSurcharge ?? 20;
  $('#cfgGophrComp').value = c.courierRules?.gophrCompressedThresholdHours ?? 6;
  $('#cfgTravelSpeed').value = c.courierRules?.travelSpeedMph ?? 18;
}

async function saveBusinessConfig() {
  try {
    const c = state.config;
    const payload = {
      printedEasy: {
        ...c.printedEasy,
        customerCutoffMinutes: Number($('#cfgPeCutoff').value),
        orderCutoffMinutes: Number($('#cfgPeOrderCutoff').value),
      },
      hrjRouting: {
        ...c.hrjRouting,
        originAddress: $('#cfgHrjOrigin').value.trim(),
        safeNextDayDeliveryHour: Number($('#cfgHrjSafeHour').value),
        minHoursEarlyTomorrow: Number($('#cfgHrjMinEarly').value),
        minHoursDirect: Number($('#cfgHrjMinDirect').value),
      },
      courierRules: {
        ...c.courierRules,
        dnpOohSurcharge: Number($('#cfgOohSurcharge').value),
        gophrCompressedThresholdHours: Number($('#cfgGophrComp').value),
        travelSpeedMph: Number($('#cfgTravelSpeed').value),
      },
    };
    const res = await fetch('/api/data/business-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to save business config');
    toast('Saved global business rules');
    await loadAllAdminData();
  } catch (err) {
    toast(err.message, 'err');
  }
}

loadAllAdminData();
