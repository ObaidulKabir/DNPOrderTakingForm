// Thin UI Presentation Client — Driven by PostgreSQL (Relational + JSONB) Multi-Product Catalog & Backend APIs.

let data = {
  productId: 'saddle-stitched-booklets',
  product: 'Saddle-stitched booklets',
  quantity: null,
  size: null,
  pages: null,
  cover: null,
  inner: null,
  paper: 'Silk / Matt',
  orientation: null,
  attributes: {},
  artwork: null,
  file: null,
  postcode: null,
  address: null,
  hotel: null,
  hotelName: null,
  deadline: null,
  devMiles: null
};

let productsCatalog = [];
let activeProductDef = null;

let uiConfig = {
  allowedSizes: ['A5', 'A4'],
  allowedOrientations: ['Portrait', 'Landscape'],
  coverStockOptions: ['350gsm Silk', '250gsm Silk', '170gsm Silk', '130gsm Silk'],
  innerStockOptions: ['170gsm Silk', '130gsm Silk', '250gsm Silk']
};

let currentStep = null;

const $ = (s) => document.querySelector(s);
const messages = $('#messages');

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function msg(t, type = 'bot') {
  const d = document.createElement('div');
  d.className = 'msg ' + type;
  d.innerHTML = t;
  messages.appendChild(d);
  messages.scrollTop = messages.scrollHeight;
}

function renderChoices(choiceItems) {
  if (!choiceItems || !choiceItems.length) return;
  const d = document.createElement('div');
  d.className = 'choices';
  choiceItems.forEach(({ label, value }) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => {
      d.remove();
      msg(esc(label), 'user');
      submitChoice(value);
    };
    d.appendChild(b);
  });
  messages.appendChild(d);
  messages.scrollTop = messages.scrollHeight;
}

function dtLocalValue(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getSpecAttrValue(key) {
  if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
    return data[key];
  }
  if (data.attributes && data.attributes[key] !== undefined && data.attributes[key] !== null && data.attributes[key] !== '') {
    return data.attributes[key];
  }
  return '';
}

function renderDynamicProductAttributesHTML() {
  if (activeProductDef && Array.isArray(activeProductDef.attributes) && activeProductDef.attributes.length > 0) {
    return activeProductDef.attributes
      .map((attr) => {
        const currentVal = getSpecAttrValue(attr.attributeKey);
        const wideClass = attr.wideInput ? ' wide' : '';
        if (attr.inputType === 'select') {
          const allowed = (attr.validationRules && attr.validationRules.allowedValues) || [];
          const opts = allowed
            .map((opt) => `<option value="${esc(opt)}" ${String(currentVal) === String(opt) ? 'selected' : ''}>${esc(opt)}</option>`)
            .join('');
          return ` <div class="spec editable"><span>${esc(attr.label)}</span><select class="spec-edit${wideClass}" data-field="${esc(attr.attributeKey)}" data-input-type="select"><option value="">Select</option>${opts}</select></div>`;
        }
        if (attr.inputType === 'number') {
          const min = (attr.validationRules && attr.validationRules.min) || 1;
          const step = (attr.validationRules && attr.validationRules.multipleOf) || 1;
          return ` <div class="spec editable"><span>${esc(attr.label)}</span><input class="spec-edit${wideClass}" data-field="${esc(attr.attributeKey)}" data-input-type="number" type="number" min="${min}" step="${step}" value="${esc(currentVal)}" placeholder="${esc(attr.placeholder || '')}"></div>`;
        }
        return ` <div class="spec editable"><span>${esc(attr.label)}</span><input class="spec-edit${wideClass}" data-field="${esc(attr.attributeKey)}" data-input-type="text" value="${esc(currentVal)}" placeholder="${esc(attr.placeholder || '')}"></div>`;
      })
      .join('\n');
  }

  // Fallback for Saddle-stitched booklets if catalog not yet loaded
  const sizeOpts = uiConfig.allowedSizes
    .map((s) => `<option value="${esc(s)}" ${data.size === s ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  const orientOpts = uiConfig.allowedOrientations
    .map((o) => `<option value="${esc(o)}" ${data.orientation === o ? 'selected' : ''}>${esc(o)}</option>`)
    .join('');
  const coverOpts = uiConfig.coverStockOptions
    .map((c) => `<option ${data.cover === c ? 'selected' : ''}>${esc(c)}</option>`)
    .join('');
  const innerOpts = uiConfig.innerStockOptions
    .map((inn) => `<option ${data.inner === inn ? 'selected' : ''}>${esc(inn)}</option>`)
    .join('');

  return `
 <div class="spec editable"><span>Finished size</span><select class="spec-edit" data-field="size"><option value="">Select</option>${sizeOpts}</select></div>
 <div class="spec editable"><span>Orientation</span><select class="spec-edit" data-field="orientation"><option value="">Select</option>${orientOpts}</select></div>
 <div class="spec editable"><span>Pages</span><input class="spec-edit" data-field="pages" type="number" min="4" step="4" value="${data.pages || ''}" placeholder="incl. cover"></div>
 <div class="spec editable"><span>Cover</span><select class="spec-edit wide" data-field="cover"><option value="">Select</option>${coverOpts}</select></div>
 <div class="spec editable"><span>Inner pages</span><select class="spec-edit wide" data-field="inner"><option value="">Select</option>${innerOpts}</select></div>`;
}

function editableSpecHTML() {
  const artwork = data.file ? 'uploaded' : (data.artwork || '');
  const productDisplay =
    productsCatalog.length > 1
      ? `<select class="spec-edit wide" data-field="productId">${productsCatalog
          .map(
            (p) =>
              `<option value="${esc(p.id)}" ${(data.productId || 'saddle-stitched-booklets') === p.id ? 'selected' : ''}>${esc(p.singularName)}</option>`
          )
          .join('')}</select>`
      : `<strong>${esc((activeProductDef && activeProductDef.singularName) || 'Saddle-stitched booklet')}</strong>`;

  return `
 <div class="spec editable"><span>Product</span>${productDisplay}</div>
 <div class="spec editable"><span>Quantity</span><input class="spec-edit" data-field="quantity" type="number" min="1" step="1" value="${data.quantity || ''}" placeholder="e.g. 25"></div>
${renderDynamicProductAttributesHTML()}
 <div class="spec editable"><span>Artwork</span><select class="spec-edit" data-field="artwork"><option value="">Select</option><option value="Ready" ${(artwork === 'Ready' || artwork === 'uploaded') ? 'selected' : ''}>Ready</option><option value="Not ready" ${artwork === 'Not ready' ? 'selected' : ''}>Not ready</option></select></div>
 <div class="spec editable"><span>Delivery postcode</span><input class="spec-edit wide" data-field="postcode" value="${esc(data.postcode || '')}" placeholder="Postcode"></div>
 <div class="spec editable"><span>Test mileage</span><input class="spec-edit" data-field="devMiles" type="number" min="0" step=".1" value="${data.devMiles ?? ''}" placeholder="Dev only"></div>
 <div class="spec editable"><span>Delivery address</span><input class="spec-edit wide" data-field="address" value="${esc(data.address || '')}" placeholder="Address"></div>
 <div class="spec editable"><span>Required by</span><input class="spec-edit wide" data-field="deadline" type="datetime-local" value="${dtLocalValue(data.deadline)}"></div>`;
}

function bindSpecEditors() {
  document.querySelectorAll('.spec-edit').forEach((el) => {
    el.addEventListener('change', async () => {
      const f = el.dataset.field;
      const v = el.value;
      const inputType = el.dataset.inputType;

      if (f === 'productId') {
        const selectedProd = productsCatalog.find((p) => p.id === v);
        data.productId = v;
        if (selectedProd) {
          activeProductDef = selectedProd;
          data.product = selectedProd.name;
          data.paper = selectedProd.defaultPaper;
        }
      } else if (f === 'quantity' || f === 'pages' || f === 'devMiles' || inputType === 'number') {
        const numVal = v !== '' ? Number(v) : null;
        data[f] = numVal;
        if (!data.attributes) data.attributes = {};
        data.attributes[f] = numVal;
      } else if (f === 'deadline') {
        data.deadline = v ? new Date(v).toISOString() : null;
      } else if (f === 'artwork') {
        data.artwork = v || null;
        if (v !== 'Ready') data.file = null;
      } else {
        const strVal = v || null;
        data[f] = strVal;
        if (!data.attributes) data.attributes = {};
        data.attributes[f] = strVal;
      }
      await evaluateSidebarSpec();
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        el.blur();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
}

function applyEvaluation(evaluation, emitBotCompletion = false) {
  if (!evaluation) return;
  data = evaluation.spec;
  if (evaluation.productDef) {
    activeProductDef = evaluation.productDef;
  }

  const { progress, quoteState, diagnosticsHtml } = evaluation;
  $('#progressBar').style.width = progress.percent + '%';
  $('#progressText').textContent = progress.progressText;
  $('#specList').innerHTML = editableSpecHTML();
  bindSpecEditors();

  const miss = progress.missingFields;
  $('#missingBox').className = 'missing ' + (miss.length ? '' : 'complete');
  $('#missingBox').innerHTML = miss.length
    ? '<strong>Still needed:</strong><br>' + miss.join(' · ')
    : '<strong>✓ Specification complete</strong><br>Changes here immediately recalculate availability, decision and price.';

  const quoteEl = $('#quote');
  const checkingEl = $('#checking');

  if (quoteState.mode === 'quote' && quoteState.total != null) {
    checkingEl.style.display = 'none';
    quoteEl.style.display = 'block';
    $('#commitment').textContent = quoteState.commitmentText || '';
    $('#price').innerHTML = `£${quoteState.total.toLocaleString('en-GB')} <small>${esc(quoteState.priceSubtext || '')}</small>`;
    if (emitBotCompletion && quoteState.botCompletionMessage) {
      msg(quoteState.botCompletionMessage, 'bot');
    }
    currentStep = 'done';
  } else if (quoteState.mode === 'checking') {
    quoteEl.style.display = 'none';
    checkingEl.style.display = 'block';
  } else {
    quoteEl.style.display = 'none';
    checkingEl.style.display = 'none';
  }

  const debugEl = $('#debug');
  if (debugEl) {
    debugEl.innerHTML = diagnosticsHtml;
  }
}

function applyConversationResponse(resp) {
  currentStep = resp.currentStep;
  $('#attach').style.display = resp.showAttach ? 'block' : 'none';
  applyEvaluation(resp.evaluation, false);

  if (Array.isArray(resp.botMessages)) {
    resp.botMessages.forEach((m) => msg(m, 'bot'));
  }
  if (Array.isArray(resp.choices) && resp.choices.length > 0) {
    renderChoices(resp.choices);
  }
}

async function evaluateSidebarSpec() {
  try {
    const res = await fetch('/api/quote/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: data })
    });
    if (!res.ok) throw new Error('Evaluation request failed');
    const evaluation = await res.json();
    applyEvaluation(evaluation, true);
  } catch (err) {
    console.error(err);
  }
}

async function start() {
  try {
    const t = $('#initialPrompt').value.trim();
    if (!t) {
      $('#initialPrompt').focus();
      return false;
    }
    $('#homeView').style.display = 'none';
    $('#appView').style.display = 'block';
    msg(esc(t), 'user');

    const res = await fetch('/api/conversation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: t, spec: data })
    });
    if (!res.ok) throw new Error('Failed to start conversation');
    const resp = await res.json();
    applyConversationResponse(resp);
    return false;
  } catch (err) {
    console.error(err);
    alert('PrintPilot could not start: ' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

async function submitChoice(value) {
  try {
    const res = await fetch('/api/conversation/choice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: data, currentStep, value })
    });
    if (!res.ok) throw new Error('Failed to process choice');
    const resp = await res.json();
    applyConversationResponse(resp);
  } catch (err) {
    console.error(err);
  }
}

async function send() {
  const t = $('#replyInput').value.trim();
  if (!t) return;
  msg(esc(t), 'user');
  $('#replyInput').value = '';

  try {
    const res = await fetch('/api/conversation/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: data, currentStep, text: t })
    });
    if (!res.ok) throw new Error('Failed to process reply');
    const resp = await res.json();
    applyConversationResponse(resp);
  } catch (err) {
    console.error(err);
  }
}

$('#file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('#fileText').textContent = '✓ ' + f.name;
  $('#attach').style.display = 'none';

  try {
    const res = await fetch('/api/conversation/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: data, fileName: f.name })
    });
    if (!res.ok) throw new Error('Failed to process upload');
    const resp = await res.json();
    applyConversationResponse(resp);
  } catch (err) {
    console.error(err);
  }
};

$('#initialPrompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    start();
  }
});

$('#replyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

function completePayment() {
  if ($('#quote').style.display === 'none') return;
  $('#composer').style.display = 'none';
  messages.style.display = 'none';
  $('#success').style.display = 'block';
  $('#quote').style.display = 'none';
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select', 'button'].includes(tag)) return;
  const q = $('#quote');
  if (q && getComputedStyle(q).display !== 'none') completePayment();
});

async function initBootstrap() {
  try {
    const res = await fetch('/api/bootstrap');
    if (!res.ok) return;
    const payload = await res.json();
    if (payload.config) {
      uiConfig = { ...uiConfig, ...payload.config };
    }
    if (Array.isArray(payload.products)) {
      productsCatalog = payload.products;
    }
    if (payload.activeProduct) {
      activeProductDef = payload.activeProduct;
    }
    if (payload.evaluation) {
      applyEvaluation(payload.evaluation, false);
    }
  } catch (err) {
    console.error('Bootstrap error:', err);
  }
}

initBootstrap();
