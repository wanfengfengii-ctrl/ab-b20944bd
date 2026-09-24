'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solveCalibration, ValidationError } = require('../src/solver');

const FEASIBLE_INPUT = {
  probes: ['T1', 'T2', 'T3'],
  reference: 'T1',
  records: [
    { id: 'R1', a: 'T2', b: 'T1', lo: 1, hi: 3 },
    { id: 'R2', a: 'T3', b: 'T2', lo: 0, hi: 2 },
    { id: 'R3', a: 'T3', b: 'T1', lo: 2, hi: 10 },
  ],
};

test('可行情形：返回紧确区间与见证，基准固定为 0', () => {
  const r = solveCalibration(FEASIBLE_INPUT);
  assert.equal(r.status, 'feasible');
  assert.deepEqual(r.intervals.T1, [0, 0]);
  assert.deepEqual(r.intervals.T2, [1, 3]);
  // x3 <= min(10, 3+2) = 5，x3 >= max(2, 1+0) = 2
  assert.deepEqual(r.intervals.T3, [2, 5]);
  assert.equal(r.witness.T1, 0);
  // 见证满足全部记录
  for (const rec of FEASIBLE_INPUT.records) {
    const d = r.witness[rec.a] - r.witness[rec.b];
    assert.ok(d >= rec.lo && d <= rec.hi, `${rec.id}: ${d} 应在 [${rec.lo}, ${rec.hi}]`);
  }
});

test('区间是紧确的：端点处均存在可行见证', () => {
  // 对每支探头的区间端点，加入等值约束后问题仍应可行
  const base = solveCalibration(FEASIBLE_INPUT);
  for (const [probe, [lo, hi]] of Object.entries(base.intervals)) {
    if (probe === FEASIBLE_INPUT.reference) continue; // 基准固定为 0，无需钉扎
    for (const v of [lo, hi]) {
      if (v === null) continue;
      const pinned = {
        ...FEASIBLE_INPUT,
        records: [
          ...FEASIBLE_INPUT.records,
          { id: 'PIN', a: probe, b: 'T1', lo: v, hi: v },
        ],
      };
      const r = solveCalibration(pinned);
      assert.equal(r.status, 'feasible', `${probe} 端点 ${v} 应可达`);
      assert.equal(r.witness[probe], v);
    }
  }
});

test('不可行情形：拒绝并给出矛盾闭环，上界累加值为负', () => {
  const r = solveCalibration({
    probes: ['T1', 'T2', 'T3'],
    reference: 'T1',
    records: [
      { id: 'R1', a: 'T2', b: 'T1', lo: 1, hi: 3 },
      { id: 'R2', a: 'T3', b: 'T2', lo: 0, hi: 2 },
      { id: 'R3', a: 'T1', b: 'T3', lo: 0, hi: 0 },
    ],
  });
  assert.equal(r.status, 'infeasible');
  assert.ok(r.sum < 0, `矛盾闭环上界累加值应为负，实际 ${r.sum}`);
  assert.ok(r.cycle.length >= 2);
  const recordEdges = r.cycle.filter((e) => e.recordId !== null);
  assert.ok(recordEdges.length >= 2);
  for (const e of recordEdges) {
    assert.ok(['forward', 'reverse'].includes(e.direction));
    assert.ok(['R1', 'R2', 'R3'].includes(e.recordId));
  }
  // 闭环边界的累加值等于报告的 sum
  assert.equal(r.cycle.reduce((s, e) => s + e.bound, 0), r.sum);
});

test('矛盾闭环确实首尾相接（按记录探头关系还原）', () => {
  const records = [
    { id: 'R1', a: 'T2', b: 'T1', lo: 1, hi: 3 },
    { id: 'R2', a: 'T3', b: 'T2', lo: 0, hi: 2 },
    { id: 'R3', a: 'T1', b: 'T3', lo: 0, hi: 0 },
  ];
  const r = solveCalibration({ probes: ['T1', 'T2', 'T3'], reference: 'T1', records });
  assert.equal(r.status, 'infeasible');
  const byId = new Map(records.map((rec) => [rec.id, rec]));
  // 将每条边还原为 (from, to)：forward 为 b→a，reverse 为 a→b
  const nodes = r.cycle.map((e) => {
    if (e.recordId === null) return null; // 基准固定边
    const rec = byId.get(e.recordId);
    return e.direction === 'forward' ? [rec.b, rec.a] : [rec.a, rec.b];
  }).filter(Boolean);
  for (let i = 0; i < nodes.length; i++) {
    assert.equal(nodes[i][1], nodes[(i + 1) % nodes.length][0], '闭环必须首尾相接');
  }
});

test('基准不同则结论不同：固定基准为零参与求解', () => {
  const r = solveCalibration({ ...FEASIBLE_INPUT, reference: 'T3' });
  assert.equal(r.status, 'feasible');
  assert.deepEqual(r.intervals.T3, [0, 0]);
  assert.equal(r.witness.T3, 0);
  assert.deepEqual(r.intervals.T1, [-5, -2]);
});

test('未与基准连通的探头区间对应方向无界', () => {
  const r = solveCalibration({
    probes: ['T1', 'T2', 'T3', 'T4'],
    reference: 'T1',
    records: [
      { id: 'R1', a: 'T2', b: 'T1', lo: 1, hi: 3 },
      { id: 'R2', a: 'T3', b: 'T1', lo: 0, hi: 2 },
      { id: 'R3', a: 'T3', b: 'T2', lo: -5, hi: 5 },
    ],
  });
  assert.equal(r.status, 'feasible');
  assert.deepEqual(r.intervals.T4, [null, null]);
  // 见证仍须满足全部记录
  for (const rec of [
    { a: 'T2', b: 'T1', lo: 1, hi: 3 },
    { a: 'T3', b: 'T1', lo: 0, hi: 2 },
    { a: 'T3', b: 'T2', lo: -5, hi: 5 },
  ]) {
    const d = r.witness[rec.a] - r.witness[rec.b];
    assert.ok(d >= rec.lo && d <= rec.hi);
  }
});

test('输入校验：数量、唯一性、整数区间、未知探头', () => {
  const base = FEASIBLE_INPUT;
  assert.throws(() => solveCalibration({ ...base, probes: ['A', 'B'] }), ValidationError);
  assert.throws(() => solveCalibration({ ...base, probes: ['A', 'A', 'B'] }), ValidationError);
  assert.throws(() => solveCalibration({ ...base, reference: 'TX' }), ValidationError);
  assert.throws(() => solveCalibration({ ...base, records: base.records.slice(0, 2) }), ValidationError);
  assert.throws(
    () => solveCalibration({ ...base, records: [...base.records, { a: 'T1', b: 'T9', lo: 0, hi: 1 }] }),
    ValidationError,
  );
  assert.throws(
    () => solveCalibration({ ...base, records: [...base.records, { a: 'T1', b: 'T2', lo: 1.5, hi: 2 }] }),
    ValidationError,
  );
  assert.throws(
    () => solveCalibration({ ...base, records: [...base.records, { a: 'T1', b: 'T2', lo: 3, hi: 2 }] }),
    ValidationError,
  );
  assert.throws(
    () => solveCalibration({ ...base, records: [...base.records, { a: 'T2', b: 'T2', lo: 0, hi: 1 }] }),
    ValidationError,
  );
});

test('记录编号缺省时自动分配 R1..Rn，重复编号被拒绝', () => {
  const r = solveCalibration({
    probes: ['T1', 'T2', 'T3'],
    reference: 'T1',
    records: [
      { a: 'T2', b: 'T1', lo: 1, hi: 3 },
      { a: 'T3', b: 'T2', lo: 0, hi: 2 },
      { a: 'T3', b: 'T1', lo: 2, hi: 10 },
    ],
  });
  assert.equal(r.status, 'feasible');
  assert.throws(
    () => solveCalibration({
      probes: ['T1', 'T2', 'T3'],
      reference: 'T1',
      records: [
        { id: 'X', a: 'T2', b: 'T1', lo: 1, hi: 3 },
        { id: 'X', a: 'T3', b: 'T2', lo: 0, hi: 2 },
        { id: 'Y', a: 'T3', b: 'T1', lo: 2, hi: 10 },
      ],
    }),
    ValidationError,
  );
});

test('联合求解区别于逐条取中值', () => {
  // 若逐条独立取中值：x2=2, x3-x2=1 → x3=3，但 R3 中值 6 与之一致性无从保证；
  // 联合求解给出的见证必须同时满足全部记录。
  const r = solveCalibration(FEASIBLE_INPUT);
  const w = r.witness;
  assert.ok(w.T2 - w.T1 >= 1 && w.T2 - w.T1 <= 3);
  assert.ok(w.T3 - w.T2 >= 0 && w.T3 - w.T2 <= 2);
  assert.ok(w.T3 - w.T1 >= 2 && w.T3 - w.T1 <= 10);
});
