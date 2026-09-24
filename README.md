# 热处理炉热电偶校正联合求解

计量工程师在页面录入 3~10 支唯一编号的热电偶、指定基准探头（校正值固定为 0），
以及 3~24 条双向比对记录；每条记录 (A, B, [下界, 上界]) 表示整数闭区间约束
`下界 ≤ 校正值(A) − 校正值(B) ≤ 上界`。提交后页面通过 `POST /api/calibrations/solve`
展示结果。

## 求解语义

- 全部记录**同时**纳入差分约束求解（Bellman-Ford），而非逐条独立取中值；
- 可行时返回每支探头可取校正值的**紧确闭区间**（端点均可达）及一组满足全部记录的校正见证；
- 不可行时明确拒绝，并给出由原始记录编号、使用方向（正向/反向）与区间上界累加值（< 0）
  组成的矛盾闭环，便于定位阻断证据；
- 页面在任一输入改动后立即撤下旧结论。

## 本地运行

```bash
npm start          # 默认监听 8080，可用 PORT 环境变量覆盖
npm test           # 单元 + 接口测试
```

## Docker

```bash
docker build -t thermocouple-calibration .
docker run -p 8080:8080 thermocouple-calibration
```

## Docker Compose

```bash
HOST_PORT=9090 docker compose up web       # 宿主机端口可配置，默认 8080
docker compose up verify                   # 一次性验收：构建检查 + 代码测试 + 业务 HTTP 冒烟
docker compose ps                          # verify 容器以退出码报告验收结果（0 通过 / 1 失败）
```

服务自带健康检查：`GET /healthz`。

## API

`POST /api/calibrations/solve`

```json
{
  "probes": ["T1", "T2", "T3"],
  "reference": "T1",
  "records": [
    { "id": "R1", "a": "T2", "b": "T1", "lo": 1, "hi": 3 }
  ]
}
```

可行响应：

```json
{
  "status": "feasible",
  "reference": "T1",
  "intervals": { "T1": [0, 0], "T2": [1, 3] },
  "witness": { "T1": 0, "T2": 2 }
}
```

不可行响应：

```json
{
  "status": "infeasible",
  "cycle": [ { "recordId": "R1", "direction": "reverse", "bound": -1 } ],
  "sum": -1
}
```
