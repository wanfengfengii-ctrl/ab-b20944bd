'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

function startServer() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const FEASIBLE_INPUT = {
  probes: ['T1', 'T2', 'T3'],
  reference: 'T1',
  records: [
    { id: 'R1', a: 'T2', b: 'T1', lo: 1, hi: 3 },
    { id: 'R2', a: 'T3', b: 'T2', lo: 0, hi: 2 },
    { id: 'R3', a: 'T3', b: 'T1', lo: 2, hi: 10 },
  ],
};

test('HTTP API 冒烟', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  await t.test('GET /healthz 返回 ok', async () => {
    const resp = await fetch(`${base}/healthz`);
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { status: 'ok' });
  });

  await t.test('GET / 返回页面', async () => {
    const resp = await fetch(`${base}/`);
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.match(text, /热电偶校正联合求解/);
  });

  await t.test('POST 可行情形返回紧确区间与见证', async () => {
    const resp = await fetch(`${base}/api/calibrations/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FEASIBLE_INPUT),
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.status, 'feasible');
    assert.deepEqual(data.intervals.T1, [0, 0]);
    assert.deepEqual(data.intervals.T3, [2, 5]);
    assert.equal(data.witness.T1, 0);
  });

  await t.test('POST 不可行情形返回矛盾闭环', async () => {
    const resp = await fetch(`${base}/api/calibrations/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        probes: ['T1', 'T2', 'T3'],
        reference: 'T1',
        records: [
          { id: 'R1', a: 'T2', b: 'T1', lo: 1, hi: 3 },
          { id: 'R2', a: 'T3', b: 'T2', lo: 0, hi: 2 },
          { id: 'R3', a: 'T1', b: 'T3', lo: 0, hi: 0 },
        ],
      }),
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.status, 'infeasible');
    assert.ok(data.sum < 0);
    assert.ok(Array.isArray(data.cycle) && data.cycle.length >= 2);
  });

  await t.test('非法输入返回 400', async () => {
    const resp = await fetch(`${base}/api/calibrations/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probes: ['A', 'B'], reference: 'A', records: [] }),
    });
    assert.equal(resp.status, 400);
    const data = await resp.json();
    assert.ok(data.error);
  });

  await t.test('非 JSON 请求体返回 400', async () => {
    const resp = await fetch(`${base}/api/calibrations/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(resp.status, 400);
  });
});
