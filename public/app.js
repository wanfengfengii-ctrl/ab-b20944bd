'use strict';

const MIN_PROBES = 3, MAX_PROBES = 10;
const MIN_RECORDS = 3, MAX_RECORDS = 24;

const probeList = document.getElementById('probe-list');
const recordList = document.getElementById('record-list');
const referenceSelect = document.getElementById('reference');
const resultSection = document.getElementById('result');
const resultBody = document.getElementById('result-body');
const staleNote = document.getElementById('stale-note');
const form = document.getElementById('calibration-form');

let probeSeq = 0;
let recordSeq = 0;

function getProbeIds() {
  return [...probeList.querySelectorAll('input.probe-id')]
    .map((i) => i.value.trim())
    .filter((s) => s.length > 0);
}

function refreshReferenceOptions() {
  const ids = getProbeIds();
  const prev = referenceSelect.value;
  referenceSelect.innerHTML = '';
  for (const id of ids) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    referenceSelect.appendChild(opt);
  }
  if (ids.includes(prev)) referenceSelect.value = prev;
  // 同步所有记录行中的探头下拉框
  for (const sel of recordList.querySelectorAll('select.probe-ref')) {
    const old = sel.value;
    sel.innerHTML = '';
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    }
    if (ids.includes(old)) sel.value = old;
  }
}

function addProbe(value) {
  if (probeList.children.length >= MAX_PROBES) return;
  probeSeq += 1;
  const row = document.createElement('div');
  row.className = 'probe-row';
  const input = document.createElement('input');
  input.className = 'probe-id';
  input.value = value || `T${probeSeq}`;
  input.maxLength = 32;
  input.required = true;
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '删除';
  del.addEventListener('click', () => {
    if (probeList.children.length > MIN_PROBES) {
      row.remove();
      refreshReferenceOptions();
      markStale();
    }
  });
  row.appendChild(input);
  row.appendChild(del);
  probeList.appendChild(row);
  refreshReferenceOptions();
}

function addRecord() {
  if (recordList.children.length >= MAX_RECORDS) return;
  recordSeq += 1;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="record-id" value="R${recordSeq}" maxlength="32" required></td>
    <td><select class="probe-ref a"></select></td>
    <td><select class="probe-ref b"></select></td>
    <td><input type="number" class="lo" step="1" value="0" required></td>
    <td><input type="number" class="hi" step="1" value="0" required></td>
    <td><button type="button" class="del">删除</button></td>`;
  tr.querySelector('.del').addEventListener('click', () => {
    if (recordList.children.length > MIN_RECORDS) {
      tr.remove();
      markStale();
    }
  });
  recordList.appendChild(tr);
  refreshReferenceOptions();
  const selects = tr.querySelectorAll('select.probe-ref');
  if (selects[0].options.length > 1) selects[1].selectedIndex = 1;
}

/** 任一输入改动后，旧结论必须撤下。 */
function markStale() {
  if (!resultSection.hidden) {
    resultSection.hidden = true;
    resultBody.innerHTML = '';
  }
  staleNote.hidden = !hadResult;
}

let hadResult = false;
form.addEventListener('input', () => {
  if (hadResult) markStale();
});
form.addEventListener('input', (e) => {
  if (e.target.classList.contains('probe-id')) refreshReferenceOptions();
});

document.getElementById('add-probe').addEventListener('click', () => { addProbe(); markStale(); });
document.getElementById('add-record').addEventListener('click', () => { addRecord(); markStale(); });

function fmtBound(v) {
  return v === null ? '无界' : String(v);
}

function renderResult(data) {
  hadResult = true;
  staleNote.hidden = true;
  resultSection.hidden = false;
  resultBody.innerHTML = '';

  if (data.status === 'feasible') {
    const p = document.createElement('p');
    p.className = 'ok';
    p.textContent = '全部记录可同时成立。基准探头校正值固定为 0，以下为每支探头可取校正值的紧确闭区间及一组满足全部记录的校正见证。';
    resultBody.appendChild(p);

    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>探头</th><th>紧确区间下界</th><th>紧确区间上界</th><th>见证校正值</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const [probe, [lo, hi]] of Object.entries(data.intervals)) {
      const tr = document.createElement('tr');
      const tag = probe === data.reference ? '（基准）' : '';
      tr.innerHTML = `<td>${probe}${tag}</td><td>${fmtBound(lo)}</td><td>${fmtBound(hi)}</td><td>${data.witness[probe]}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    resultBody.appendChild(table);
    return;
  }

  if (data.status === 'infeasible') {
    const p = document.createElement('p');
    p.className = 'bad';
    p.textContent = `求解被拒绝：${data.message}。区间上界累加值 = ${data.sum}（< 0 即矛盾）。`;
    resultBody.appendChild(p);

    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>#</th><th>记录编号</th><th>使用方向</th><th>区间上界</th></tr></thead>';
    const tbody = document.createElement('tbody');
    data.cycle.forEach((edge, i) => {
      const tr = document.createElement('tr');
      const dir = edge.direction === 'forward' ? '正向 (A−B ≤ 上界)'
        : edge.direction === 'reverse' ? '反向 (B−A ≤ −下界)'
        : '基准固定';
      tr.innerHTML = `<td>${i + 1}</td><td>${edge.recordId === null ? '—' : edge.recordId}</td><td>${dir}</td><td>${edge.bound}</td>`;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    resultBody.appendChild(table);
    return;
  }

  const p = document.createElement('p');
  p.className = 'bad';
  p.textContent = data.error || '未知错误';
  resultBody.appendChild(p);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const probes = getProbeIds();
  const records = [...recordList.querySelectorAll('tr')].map((tr) => ({
    id: tr.querySelector('.record-id').value.trim(),
    a: tr.querySelector('.a').value,
    b: tr.querySelector('.b').value,
    lo: Number(tr.querySelector('.lo').value),
    hi: Number(tr.querySelector('.hi').value),
  }));
  const payload = { probes, reference: referenceSelect.value, records };

  let data;
  try {
    const resp = await fetch('/api/calibrations/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await resp.json();
  } catch {
    data = { error: '网络请求失败' };
  }
  renderResult(data);
});

// 初始最小表单
for (let i = 0; i < MIN_PROBES; i++) addProbe();
for (let i = 0; i < MIN_RECORDS; i++) addRecord();
refreshReferenceOptions();
