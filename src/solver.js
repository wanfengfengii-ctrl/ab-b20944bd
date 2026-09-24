'use strict';

/**
 * 热电偶校正联合求解器。
 *
 * 模型：设每支探头 i 的校正值为 x_i（基准探头固定为 0）。
 * 每条比对记录 (a, b, [lo, hi]) 表示校正后温差约束：
 *     lo <= x_a - x_b <= hi
 * 这是一组差分约束（system of difference constraints），
 * 用 Bellman-Ford 同时求解全部约束：
 *   - 可行性：约束图中不存在负环；
 *   - 每支探头的紧确区间：以虚拟零点 Z（与基准探头双向零权相连）为源点的
 *     最短路径给出上界，反向图最短路径给出下界；
 *   - 见证：超源（所有节点距离初始为 0）Bellman-Ford 收敛后的势函数，
 *     整体平移使基准为 0，即为一组满足全部记录的校正值；
 *   - 不可行时：从负环提取由原始记录编号、使用方向与区间上界组成的矛盾闭环。
 */

const MAX_ABS_BOUND = 1e6;
const MIN_PROBES = 3;
const MAX_PROBES = 10;
const MIN_RECORDS = 3;
const MAX_RECORDS = 24;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeProbeId(v, what) {
  if (typeof v !== 'string') throw new ValidationError(`${what} 必须是非空字符串`);
  const id = v.trim();
  if (id.length === 0 || id.length > 32) {
    throw new ValidationError(`${what} 长度须为 1~32 个字符`);
  }
  return id;
}

function normalizeBound(v, what) {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ValidationError(`${what} 必须是整数`);
  }
  if (Math.abs(v) > MAX_ABS_BOUND) {
    throw new ValidationError(`${what} 绝对值不能超过 ${MAX_ABS_BOUND}`);
  }
  return v;
}

/** 校验并规范化输入，返回 { probes, reference, records }。 */
function normalize(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError('请求体必须是 JSON 对象');
  }

  if (!Array.isArray(input.probes)) {
    throw new ValidationError('probes 必须是探头编号数组');
  }
  if (input.probes.length < MIN_PROBES || input.probes.length > MAX_PROBES) {
    throw new ValidationError(`探头数量须为 ${MIN_PROBES}~${MAX_PROBES} 支`);
  }
  const probes = input.probes.map((p, i) => normalizeProbeId(p, `探头编号 #${i + 1}`));
  if (new Set(probes).size !== probes.length) {
    throw new ValidationError('探头编号必须唯一');
  }

  const reference = normalizeProbeId(input.reference, '基准探头编号');
  if (!probes.includes(reference)) {
    throw new ValidationError('基准探头必须在探头列表中');
  }

  if (!Array.isArray(input.records)) {
    throw new ValidationError('records 必须是比对记录数组');
  }
  if (input.records.length < MIN_RECORDS || input.records.length > MAX_RECORDS) {
    throw new ValidationError(`比对记录数量须为 ${MIN_RECORDS}~${MAX_RECORDS} 条`);
  }
  const seenIds = new Set();
  const records = input.records.map((r, i) => {
    if (!isPlainObject(r)) throw new ValidationError(`记录 #${i + 1} 必须是对象`);
    const id = r.id === undefined || r.id === null
      ? `R${i + 1}`
      : normalizeProbeId(String(r.id), `记录 #${i + 1} 编号`);
    if (seenIds.has(id)) throw new ValidationError(`记录编号重复：${id}`);
    seenIds.add(id);
    const a = normalizeProbeId(r.a, `记录 ${id} 的探头 A`);
    const b = normalizeProbeId(r.b, `记录 ${id} 的探头 B`);
    if (!probes.includes(a)) throw new ValidationError(`记录 ${id} 引用了未知探头 ${a}`);
    if (!probes.includes(b)) throw new ValidationError(`记录 ${id} 引用了未知探头 ${b}`);
    if (a === b) throw new ValidationError(`记录 ${id} 的两个探头不能相同`);
    const lo = normalizeBound(r.lo, `记录 ${id} 的区间下界`);
    const hi = normalizeBound(r.hi, `记录 ${id} 的区间上界`);
    if (lo > hi) throw new ValidationError(`记录 ${id} 的区间下界不能大于上界`);
    return { id, a, b, lo, hi };
  });

  return { probes, reference, records };
}

/** 单源 Bellman-Ford，返回距离数组（不可达为 Infinity）。 */
function shortestPathsFrom(source, nodeCount, edges) {
  const dist = new Array(nodeCount).fill(Infinity);
  dist[source] = 0;
  for (let i = 0; i < nodeCount - 1; i++) {
    let changed = false;
    for (const e of edges) {
      if (dist[e.from] !== Infinity && dist[e.to] > dist[e.from] + e.w) {
        dist[e.to] = dist[e.from] + e.w;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return dist;
}

/**
 * 求解校正问题。
 * @returns 可行：{ status:'feasible', reference, intervals, witness }
 *          不可行：{ status:'infeasible', cycle, sum }
 */
function solveCalibration(input) {
  const { probes, reference, records } = normalize(input);

  const n = probes.length;
  const index = new Map(probes.map((p, i) => [p, i]));
  const Z = n; // 虚拟零点，与基准探头双向零权相连，固定基准校正值为 0
  const nodeCount = n + 1;

  // 约束 x_a - x_b <= hi  ⇒  边 b→a 权 hi   （记录正向使用，上界为 hi）
  // 约束 x_b - x_a <= -lo ⇒  边 a→b 权 -lo  （记录反向使用，上界为 -lo）
  const edges = [];
  for (const r of records) {
    const a = index.get(r.a);
    const b = index.get(r.b);
    edges.push({ from: b, to: a, w: r.hi, recordId: r.id, direction: 'forward' });
    edges.push({ from: a, to: b, w: -r.lo, recordId: r.id, direction: 'reverse' });
  }
  const ref = index.get(reference);
  edges.push({ from: Z, to: ref, w: 0, recordId: null, direction: 'fix' });
  edges.push({ from: ref, to: Z, w: 0, recordId: null, direction: 'fix' });

  // 超源 Bellman-Ford：所有节点初始距离为 0，可同时检测任意连通分量中的负环，
  // 收敛后的距离即为一组可行势函数。
  const dist = new Array(nodeCount).fill(0);
  const pred = new Array(nodeCount).fill(null);
  let lastRelaxed = null;
  for (let i = 0; i < nodeCount; i++) {
    lastRelaxed = null;
    for (const e of edges) {
      if (dist[e.to] > dist[e.from] + e.w) {
        dist[e.to] = dist[e.from] + e.w;
        pred[e.to] = e;
        lastRelaxed = e.to;
      }
    }
    if (lastRelaxed === null) break;
  }

  if (lastRelaxed !== null) {
    // 存在负环：沿前驱指针走 nodeCount 步确保进入环内，再收集整环。
    let y = lastRelaxed;
    for (let i = 0; i < nodeCount; i++) y = pred[y].from;
    const cycleEdges = [];
    let cur = y;
    do {
      const e = pred[cur];
      cycleEdges.push(e);
      cur = e.from;
    } while (cur !== y);
    cycleEdges.reverse();
    const sum = cycleEdges.reduce((s, e) => s + e.w, 0);
    return {
      status: 'infeasible',
      message: '比对记录不可同时成立，检测到矛盾闭环',
      cycle: cycleEdges.map((e) => (e.recordId === null
        ? { recordId: null, direction: 'fix', bound: e.w, note: '基准探头固定为 0' }
        : { recordId: e.recordId, direction: e.direction, bound: e.w })),
      sum,
    };
  }

  // 见证：势函数整体平移，使基准探头校正值为 0。
  const shift = dist[ref];
  const witness = {};
  probes.forEach((p, i) => {
    witness[p] = dist[i] - shift;
  });

  // 紧确区间：上界 = Z 到 i 的最短路；下界 = -(i 到 Z 的最短路)。
  const upper = shortestPathsFrom(Z, nodeCount, edges);
  const reversed = edges.map((e) => ({ from: e.to, to: e.from, w: e.w }));
  const toZero = shortestPathsFrom(Z, nodeCount, reversed);
  const intervals = {};
  probes.forEach((p, i) => {
    const hi = Number.isFinite(upper[i]) ? upper[i] + 0 : null; // null 表示该方向无界
    const lo = Number.isFinite(toZero[i]) ? -toZero[i] + 0 : null; // +0 消除 -0
    intervals[p] = [lo, hi];
  });

  return { status: 'feasible', reference, intervals, witness };
}

module.exports = {
  solveCalibration,
  ValidationError,
  LIMITS: { MIN_PROBES, MAX_PROBES, MIN_RECORDS, MAX_RECORDS, MAX_ABS_BOUND },
};
