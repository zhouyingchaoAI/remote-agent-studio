const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tm = require('../electron/targetMonitor');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const watch = { units: ['x.service'], paths: ['/home/models/Q'], scripts: ['retry.sh'], images: [] };
const scanOf = (o = {}) => ({ units: [], pathSizes: new Map(), tasks: [], ...o });

/* ------------------------------------------ 为什么改成以目标为中心 */

test('这一轮没扫到进程,记录也不能消失', () => {
  /* 这是"看不到持续进度"的根因。
     `systemctl restart --no-block` 一秒就退、重试脚本在 sleep 间隙没有进程 ——
     按进程建模的话记录随时被删,历史跟着没了,于是永远只有瞬时快照。
     目标(服务/目录)从任务开始到结束一直在,才攒得出"持续"。 */
  let r = tm.updateTargets([], {
    watch, now: 0,
    scan: scanOf({ tasks: [{ pid: 9, command: 'bash /usr/local/bin/retry.sh', writeBytes: 100 }] })
  });
  assert.equal(r.find((x) => x.kind === 'proc').state, 'running');

  // 下一轮进程不见了
  r = tm.updateTargets(r, { watch, scan: scanOf(), now: 10000 });
  const proc = r.find((x) => x.kind === 'proc');
  assert.ok(proc, '记录被删了 —— 持续进度就是这样丢的');
  assert.equal(proc.state, 'idle');
  assert.equal(proc.samples.length, 1, '历史采样必须留着');
});

test('单元这轮查不到标 unknown,不是 failed', () => {
  // 查不到可能只是这次 systemctl 没返回,断言成失败是在编造结论
  const r = tm.updateTargets([], { watch, scan: scanOf(), now: 0 });
  assert.equal(r.find((x) => x.kind === 'unit').state, 'unknown');
});

test('activating 映射成"启动中" —— 那正是你在等的那段', () => {
  const r = tm.updateTargets([], {
    watch, now: 0,
    scan: scanOf({ units: [{ unit: 'x.service', activeState: 'activating', subState: 'start', lastLog: 'Pulling' }] })
  });
  assert.equal(r.find((x) => x.kind === 'unit').state, 'starting');
});

/* ------------------------------------------------- 持续进度本身 */

test('跨采样累积出增量和速率', () => {
  /* 单个快照只能说"现在多大",而人想知道的是
     **从开始到现在涨了多少、现在还在不在涨**。 */
  let r = tm.updateTargets([], { watch, scan: scanOf({ pathSizes: new Map([['/home/models/Q', 1e9]]) }), now: 0 });
  r = tm.updateTargets(r, { watch, scan: scanOf({ pathSizes: new Map([['/home/models/Q', 1.6e9]]) }), now: 60000 });
  const p = r.find((x) => x.kind === 'path');
  assert.equal(p.grownBytes, 6e8);
  assert.equal(Math.round(p.bytesPerSec / 1e6), 10);
});

test('速率只看最近一分钟,不是全程平均', () => {
  /* 全程平均会把早期的快和现在的卡糊成一个中间值,
     而你要判断的恰恰是"现在还动不动"。 */
  const rec = {
    samples: [
      { at: 0, bytes: 0 }, { at: 10_000, bytes: 1e9 },   // 早期很快
      { at: 600_000, bytes: 1e9 }, { at: 640_000, bytes: 1e9 }  // 现在不动了
    ]
  };
  const p = tm.progressOf(rec, 650_000);
  assert.equal(p.bytesPerSec, 0, '应反映"现在停了",而不是全程平均');
  assert.equal(p.grownBytes, 1e9, '总增量仍是从头算');
});

test('采样太少时不敢说停滞', () => {
  // 样本不足时说"停滞"和瞎猜没区别,而误报会让人去查不存在的故障
  const few = tm.progressOf({ samples: [{ at: 0, bytes: 5 }] }, 10 ** 9);
  assert.equal(few.idle, false);
});

test('够久没涨才判 idle', () => {
  const s = [{ at: 0, bytes: 5 }, { at: 1000, bytes: 5 }, { at: 2000, bytes: 5 }];
  assert.equal(tm.progressOf({ samples: s }, 3000).idle, false);
  assert.equal(tm.progressOf({ samples: s }, 200_000).idle, true);
});

test('采样数量有上限,不会无限攒', () => {
  let r = [];
  for (let i = 0; i < tm.MAX_SAMPLES + 20; i += 1) {
    r = tm.updateTargets(r, { watch, scan: scanOf({ pathSizes: new Map([['/home/models/Q', i]]) }), now: i * 1000 });
  }
  assert.ok(r.find((x) => x.kind === 'path').samples.length <= tm.MAX_SAMPLES);
});

test('目标从对话清单里过期后,记录才消失', () => {
  const r = tm.updateTargets([], { watch, scan: scanOf(), now: 0 });
  assert.ok(r.length > 0);
  assert.deepEqual(tm.dropUnwatched(r, { units: [], paths: [], scripts: [], images: [] }), []);
});

/* ------------------------------------------------------- 接线 */

test('主进程按目标累积并随快照送出', () => {
  const main = read('electron/main.js');
  assert.match(main, /targetMonitor\.updateTargets\(st\.targets \|\| \[\]/);
  assert.match(main, /targetMonitor\.dropUnwatched\(/);
  assert.match(main, /const targets = \[\.\.\.bgState\.entries\(\)\]/);
});

test('界面把目标排在最前,并显示增量而不只是当前大小', () => {
  /* 「涨了多少」比「现在多大」有用:后者看不出这段时间有没有推进。 */
  const ui = read('src/components/BgTasksDrawer.jsx');
  assert.match(ui, /function TargetRow/);
  assert.match(ui, /已增长 \{fmtBytes\(rec\.grownBytes\)\}/);
  assert.match(ui, /已持续/);
  // 「当前没有进程」不等于「结束了」,得说清楚
  assert.match(ui, /重试型任务在两次尝试之间本来就没有进程/);
});
