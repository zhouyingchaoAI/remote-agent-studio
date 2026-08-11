/**
 * 移动端控制 API —— 给 OpenClaw(进而给微信)调用的本地接口。
 *
 * 架构分工:
 *   微信 → 腾讯官方 channel 插件 → OpenClaw Gateway → 本模块 → AgentSession → 远程主机
 * 微信接入、NAT 穿透、消息分块、发送方鉴权全部由 OpenClaw 负责;
 * 本模块只做一件事:把「跑一个任务」暴露成 HTTP。
 *
 * 安全基线(照搬 OpenClaw 自己的做法,因为这条链路能在你的服务器上执行命令):
 *   - 只绑 127.0.0.1,永不监听 0.0.0.0
 *   - Bearer token 鉴权,定长比较防时序侧信道
 *   - 默认 workspace 权限模式(不给 CLI --dangerously-bypass)
 *   - 任务回执里明确列出执行过的危险命令
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_PORT = 18790;
const MAX_BODY = 256 * 1024;      // 手机发来的指令不该有这个量级
const MAX_PROMPT = 8000;

/** 生成 token:32 字节随机,base64url 无特殊字符便于放进 URL 和配置 */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * 定长比较。直接用 === 会因为提前返回而泄漏前缀正确的长度,
 * 攻击者可以逐字节爆破出 token。
 */
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (!b.length) return false;          // 没配 token 就一律拒绝,不能"空 token 放行"
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 从请求头里取 Bearer token */
function bearerOf(req) {
  const raw = req.headers?.authorization || '';
  const m = String(raw).match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : '';
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch (_) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * 路由分发(纯函数,不碰 http 对象)—— 便于单测。
 * @param deps { listHosts, startTask, getTask, listTasks, cancelTask }
 * @returns {status, body}
 */
async function route({ method, pathname, body }, deps) {
  if (method === 'GET' && pathname === '/api/health') {
    return { status: 200, body: { ok: true, service: 'remote-agent-studio' } };
  }

  if (method === 'GET' && pathname === '/api/hosts') {
    return { status: 200, body: { hosts: await deps.listHosts() } };
  }

  if (method === 'GET' && pathname === '/api/tasks') {
    return { status: 200, body: { tasks: await deps.listTasks() } };
  }

  if (method === 'POST' && pathname === '/api/tasks') {
    const prompt = String(body?.prompt || '').trim();
    const hostId = String(body?.hostId || '').trim();
    if (!prompt) return { status: 400, body: { error: '缺少 prompt' } };
    if (prompt.length > MAX_PROMPT) return { status: 400, body: { error: `prompt 过长(上限 ${MAX_PROMPT} 字符)` } };
    if (!hostId) return { status: 400, body: { error: '缺少 hostId,先调 GET /api/hosts 拿列表' } };
    try {
      return { status: 200, body: await deps.startTask({ hostId, prompt, engine: body?.engine, model: body?.model }) };
    } catch (e) {
      return { status: 400, body: { error: e.message } };
    }
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)(\/cancel)?$/);
  if (taskMatch) {
    const [, id, cancel] = taskMatch;
    if (cancel && method === 'POST') {
      return { status: 200, body: await deps.cancelTask(id) };
    }
    if (method === 'GET') {
      const task = await deps.getTask(id);
      if (!task) return { status: 404, body: { error: '任务不存在' } };
      return { status: 200, body: task };
    }
  }

  return { status: 404, body: { error: `未知接口 ${method} ${pathname}` } };
}

/**
 * 启动 HTTP 服务。
 * @param opts { token, port, deps }
 */
function createGateway({ token, port = DEFAULT_PORT, deps }) {
  const server = http.createServer(async (req, res) => {
    const reply = (status, obj) => {
      const payload = JSON.stringify(obj);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        // 不给浏览器留跨站可乘之机:这个接口只给本机的 OpenClaw 调
        'Access-Control-Allow-Origin': 'null',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(payload);
    };

    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      if (!tokenMatches(bearerOf(req), token)) {
        return reply(401, { error: '鉴权失败:请在请求头带 Authorization: Bearer <token>' });
      }

      const body = req.method === 'POST' ? await readBody(req) : {};
      const { status, body: out } = await route(
        { method: req.method, pathname: url.pathname, body }, deps
      );
      reply(status, out);
    } catch (e) {
      reply(500, { error: e.message || '内部错误' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 只绑回环地址 —— 绝不能让局域网/公网直接摸到这个能执行命令的接口
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, port: server.address().port });
    });
  });
}

module.exports = {
  DEFAULT_PORT, MAX_PROMPT,
  generateToken, tokenMatches, bearerOf, readBody, route, createGateway
};
