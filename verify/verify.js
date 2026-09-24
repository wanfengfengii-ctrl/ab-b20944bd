'use strict';

/**
 * 一次性验收服务：
 *   1. 构建检查：对所有源码文件执行 node --check，并解析 package.json；
 *   2. 代码测试：node --test 运行全部单元/接口测试；
 *   3. 业务 HTTP 冒烟：对 TARGET_URL（默认 http://localhost:8080）执行
 *      健康检查、可行求解、不可行求解三组请求。
 * 全部通过则以退出码 0 退出，否则以退出码 1 退出。
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TARGET_URL = (process.env.TARGET_URL || 'http://localhost:8080').replace(/\/$/, '');

let failures = 0;

function pass(msg) { console.log(`  [通过] ${msg}`); }
function fail(msg) { console.error(`  [失败] ${msg}`); failures += 1; }

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function buildCheck() {
  console.log('== 1/3 构建检查 ==');
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    pass('package.json 可解析');
  } catch (err) {
    fail(`package.json 解析失败：${err.message}`);
  }
  const files = ['src', 'public', 'verify', 'test']
    .flatMap((d) => listJsFiles(path.join(ROOT, d)));
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status === 0) pass(`语法检查 ${path.relative(ROOT, f)}`);
    else fail(`语法检查 ${path.relative(ROOT, f)}：${r.stderr.trim()}`);
  }
}

function codeTests() {
  console.log('== 2/3 代码测试 ==');
  const r = spawnSync(process.execPath, ['--test'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status === 0) pass('node --test 全部通过');
  else fail(`node --test 退出码 ${r.status}`);
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json() };
}

async function waitForHealth(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(`${TARGET_URL}/healthz`);
      if (resp.ok) return true;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function httpSmoke() {
  console.log(`== 3/3 业务 HTTP 冒烟（${TARGET_URL}）==`);
  if (await waitForHealth()) pass('GET /healthz 健康检查通过');
  else { fail('GET /healthz 在超时时间内未就绪'); return; }

  // 可行情形：紧确区间 T2∈[1,3]、T3∈[2,5]，基准 T1 固定为 0
  const feasible = {
    probes: ['T1', 'T2', 'T3'],
    reference: 'T1',
    records: [
      { id: 'R1', a: 'T2', b: 'T1', lo: 1, hi: 3 },
      { id: 'R2', a: 'T3', b: 'T2', lo: 0, hi: 2 },
      { id: 'R3', a: 'T3', b: 'T1', lo: 2, hi: 10 },
    ],
  };
  try {
    const { status, data } = await postJson(`${TARGET_URL}/api/calibrations/solve`, feasible);
    const ok = status === 200
      && data.status === 'feasible'
      && JSON.stringify(data.intervals.T1) === '[0,0]'
      && JSON.stringify(data.intervals.T2) === '[1,3]'
      && JSON.stringify(data.intervals.T3) === '[2,5]'
      && data.witness.T1 === 0
      && feasible.records.every((rec) => {
        const d = data.witness[rec.a] - data.witness[rec.b];
        return d >= rec.lo && d <= rec.hi;
      });
    if (ok) pass('可行情形返回紧确区间与合法见证');
    else fail(`可行情形响应异常：${JSON.stringify(data)}`);
  } catch (err) {
    fail(`可行情形请求失败：${err.message}`);
  }

  // 不可行情形：必须拒绝并给出上界累加值为负的矛盾闭环
  const infeasible = {
    probes: ['T1', 'T2', 'T3'],
    reference: 'T1',
    records: [
      { id: 'R1', a: 'T2', b: 'T1', lo: 1, hi: 3 },
      { id: 'R2', a: 'T3', b: 'T2', lo: 0, hi: 2 },
      { id: 'R3', a: 'T1', b: 'T3', lo: 0, hi: 0 },
    ],
  };
  try {
    const { status, data } = await postJson(`${TARGET_URL}/api/calibrations/solve`, infeasible);
    const ok = status === 200
      && data.status === 'infeasible'
      && typeof data.sum === 'number' && data.sum < 0
      && Array.isArray(data.cycle) && data.cycle.length >= 2
      && data.cycle.some((e) => e.recordId !== null)
      && data.cycle.every((e) => e.recordId === null
        || ['forward', 'reverse'].includes(e.direction));
    if (ok) pass(`不可行情形被拒绝并给出矛盾闭环（累加值 ${data.sum}）`);
    else fail(`不可行情形响应异常：${JSON.stringify(data)}`);
  } catch (err) {
    fail(`不可行情形请求失败：${err.message}`);
  }
}

async function main() {
  buildCheck();
  codeTests();
  await httpSmoke();
  if (failures === 0) {
    console.log('\n验收通过：构建检查、代码测试、业务 HTTP 冒烟全部成功。');
    process.exit(0);
  } else {
    console.error(`\n验收失败：共 ${failures} 项未通过。`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`验收过程异常：${err.stack || err}`);
  process.exit(1);
});
