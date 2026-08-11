/**
 * 每日自动沉淀:定时把当天对话里的"经验"提炼进 Obsidian,全程无感知。
 *
 * 设计要点:
 *  - 每天固定时间跑一次;应用当时没开则下次启动补跑(否则那天的经验就永久丢了)
 *  - 用固定的小模型抽取,成本可控
 *  - 只沉淀有实质产出的对话,避免把闲聊也写进知识库
 *  - 全程静默:不弹窗、不打断,失败只记状态
 *
 * 调度相关的时间计算是纯函数,便于单测(定时任务最怕的就是"到点没跑/跑两次")。
 */
const fs = require('fs');
const path = require('path');

let _app = null;
let _deps = {};   // { runDigest: async ({date}) => result }
let _timer = null;

function init(app, deps) { _app = app; _deps = deps || {}; }
function statePath() { return path.join(_app.getPath('userData'), 'auto-capture.json'); }

const DEFAULTS = {
  enabled: false,
  time: '22:00',        // 每日触发时间(本地)
  hostId: 'local',
  // 默认让程序自动挑能用的引擎:手工指定太容易配错(装了没登录/架构不符/模型没额度)
  agent: '',
  model: '',
  minConversations: 1
};

function getConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) }; }
  catch (_) { return { ...DEFAULTS }; }
}

function setConfig(patch = {}) {
  const next = { ...getConfig(), ...patch };
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2));
  schedule(); // 配置变了立即重排
  return next;
}

/** 解析 "HH:MM";非法值回落到默认 22:00 */
function parseTime(text) {
  const m = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
  const h = m ? Number(m[1]) : 22;
  const min = m ? Number(m[2]) : 0;
  if (!Number.isFinite(h) || h < 0 || h > 23 || !Number.isFinite(min) || min < 0 || min > 59) {
    return { hour: 22, minute: 0 };
  }
  return { hour: h, minute: min };
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 距离下一次触发的毫秒数(今天还没到点就今天,否则明天) */
function msUntilNext(timeText, now = new Date()) {
  const { hour, minute } = parseTime(timeText);
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/**
 * 是否需要补跑:今天已过触发时间、且今天还没跑过。
 * 应用不是常开的桌面工具,没有补跑机制的话关机一天就丢一天。
 */
function shouldCatchUp({ time, lastRunDate }, now = new Date()) {
  const { hour, minute } = parseTime(time);
  const passed = now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
  return passed && lastRunDate !== dayKey(now);
}

/** 跑一次(会更新 lastRunDate,避免重复) */
async function runOnce({ force = false, date } = {}) {
  const cfg = getConfig();
  const now = new Date();
  const day = date || dayKey(now);
  if (!force && cfg.lastRunDate === day) return { skipped: true, reason: 'alreadyRan' };
  let result;
  try {
    result = await _deps.runDigest({ date: day, cfg });
    setConfigSilent({
      lastRunDate: day,
      lastRunAt: Date.now(),
      lastResult: { ok: true, count: result?.count || 0, created: result?.created || 0, merged: result?.merged || 0 }
    });
  } catch (e) {
    // 静默失败:记下原因,不打扰用户;明天还会再试
    setConfigSilent({ lastRunAt: Date.now(), lastResult: { ok: false, error: String(e?.message || e).slice(0, 300) } });
    return { ok: false, error: String(e?.message || e) };
  }
  return { ok: true, ...result };
}

/** 写配置但不重排定时器(避免 runOnce 内部触发重排) */
function setConfigSilent(patch) {
  const next = { ...getConfig(), ...patch };
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2));
  return next;
}

/** 安排下一次触发;开关关闭时清掉定时器 */
function schedule() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  const cfg = getConfig();
  if (!cfg.enabled) return;
  const delay = msUntilNext(cfg.time);
  _timer = setTimeout(async () => {
    await runOnce().catch(() => {});
    schedule(); // 跑完排下一天
  }, delay);
  if (_timer.unref) _timer.unref();
}

/** 应用启动时调用:补跑 + 排程 */
async function start() {
  const cfg = getConfig();
  if (cfg.enabled && shouldCatchUp(cfg)) {
    // 延迟一点再补跑,别和启动流程抢资源
    setTimeout(() => runOnce().catch(() => {}), 15000).unref?.();
  }
  schedule();
}

function stop() { if (_timer) { clearTimeout(_timer); _timer = null; } }

module.exports = {
  init, getConfig, setConfig, runOnce, start, stop, schedule,
  parseTime, msUntilNext, shouldCatchUp, dayKey, DEFAULTS
};
