const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { loadEsm } = require('./helpers/loadEsm');
const d = require('../electron/ssh/modelDiscovery');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ============================================================
 * 模型列表自动发现。
 *
 * 写死清单有两个躲不开的问题:
 *  1. 永远落后一轮 —— gpt-5-codex 在列表里躺到退役之后很久,
 *     期间选中它的人只会收到一句没头没尾的报错;
 *  2. 对自建/中转端点**完全无关** —— 那里的模型叫 gpt-5.6-terra
 *     这种名字,官方清单里一个都没有。
 *
 * 端点自己知道答案。问它。
 * ============================================================ */

/* ---------------------------------------------- 密钥不能进命令行 */

test('密钥只以变量名出现,绝不内联', () => {
  /* 命令行在 ps 里是所有人可见的。把 key 拼进去等于贴在公告板上。
     这是这个仓库既有的铁律,这里必须照做。 */
  const cmd = d.buildDiscoverCommand({ engine: 'codex', baseUrl: 'https://x.com', envKey: 'MY_KEY' });
  assert.match(cmd, /\$\{MY_KEY:-\}/);
  assert.ok(!cmd.includes('sk-'), '不该出现任何密钥字面量');
});

test('端点和变量名不合法时不生成命令', () => {
  /* 两者都会原样进 shell。宁可什么都不做,也不执行一条拼歪的命令。 */
  for (const bad of [
    { engine: 'codex', baseUrl: 'ftp://x', envKey: 'K' },
    { engine: 'codex', baseUrl: 'http://x', envKey: 'K;rm -rf /' },
    { engine: 'codex', baseUrl: 'http://x" ;id', envKey: 'K' },
    // 注意:baseUrl / envKey 留空是**合法**的,会退回默认端点和默认变量名 ——
    // 那是有意为之,不该当成非法输入
    { engine: 'codex', baseUrl: 'http://x', envKey: '1bad' }
  ]) {
    assert.equal(d.buildDiscoverCommand(bad), '', JSON.stringify(bad));
  }
});

test('两种鉴权头都带上', () => {
  /* OpenAI 系认 Authorization: Bearer,Anthropic 认 x-api-key。
     多带一个头不会出错;分两条命令试要多一次往返、还得先猜是哪种。 */
  const cmd = d.buildDiscoverCommand({ engine: 'claude', baseUrl: 'https://x.com', envKey: 'K' });
  assert.match(cmd, /Authorization: Bearer/);
  assert.match(cmd, /x-api-key/);
  assert.match(cmd, /anthropic-version/);
});

/* ---------------------------------------------- 真 HTTP 验证 */

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler).listen(0, async () => {
      const port = srv.address().port;
      try { await fn(`http://127.0.0.1:${port}`); resolve(); }
      catch (e) { reject(e); }
      finally { srv.close(); }
    });
  });
}

/**
 * 真的把命令跑起来,拿真实 curl 的输出去解析。
 *
 * **必须是异步的。** 用 execFileSync 会把事件循环卡住,
 * 而测试服务器就在同一个进程里 —— curl 连过去,服务器根本没机会 accept,
 * 结果是整整 20 秒超时,看着像"网络不通"。我第一版就是这么挂的。
 */
async function probe(baseUrl, key) {
  const cmd = d.buildDiscoverCommand({ engine: 'codex', baseUrl, envKey: 'RAS_TEST_KEY' });
  const { stdout } = await execFileAsync('bash', ['-c', cmd], {
    encoding: 'utf8', env: { ...process.env, RAS_TEST_KEY: key }
  });
  return d.parseDiscover(stdout);
}

test('端点返回列表时解析出模型', async () => {
  await withServer((req, res) => {
    if (!String(req.headers.authorization || '').includes('GOOD')) { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-5.6-terra' }] }));
  }, async (base) => {
    const r = await probe(base, 'GOOD');
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.models.map((m) => m.value), ['gpt-6.1-sol', 'gpt-5.6-terra']);
  });
});

test('Anthropic 的 display_name 会显示出来', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Opus 5.5' }] }));
  }, async (base) => {
    const r = await probe(base, 'K');
    assert.match(r.models[0].label, /Opus 5\.5/);
  });
});

test('各类失败要分得清,不能笼统一句"没拿到"', async () => {
  /* 401 该改密钥、404 该改端点地址、连不上该查网络 ——
     三者动的地方完全不同,混成一句话等于没说。 */
  await withServer((req, res) => {
    if (req.url.startsWith('/bad')) { res.writeHead(404); return res.end('nope'); }
    if (req.url.startsWith('/html')) { res.writeHead(200); return res.end('<html>login</html>'); }
    if (req.url.startsWith('/empty')) { res.writeHead(200); return res.end('{"data":[]}'); }
    res.writeHead(401); res.end('{}');
  }, async (base) => {
    assert.match((await probe(base, 'WRONG')).error, /密钥无效/);
    assert.match((await probe(`${base}/bad`, 'K')).error, /\/v1\/models/);
    assert.match((await probe(`${base}/html`, 'K')).error, /不是 JSON/);
    assert.match((await probe(`${base}/empty`, 'K')).error, /空列表/);
  });
  // 端口不通
  assert.match((await probe('http://127.0.0.1:9', 'K')).error, /没有返回/);
});

test('报错正文不会被当成模型名收进来', async () => {
  /* 返回体里什么都可能有。不过滤的话,一句错误提示会变成
     下拉框里一个看着像模型的选项。 */
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: '你的额度已用完,请联系管理员' }, { id: 'ok-model' }, { id: '' }] }));
  }, async (base) => {
    const r = await probe(base, 'K');
    assert.deepEqual(r.models.map((m) => m.value), ['ok-model']);
  });
});

/* ---------------------------------------------- 合并规则 */

const M = loadEsm('src/mergeModels.js');

for (const [name, merge] of [['主进程', d.mergeModels], ['渲染端', M.mergeModels]]) {
  test(`${name}:发现到的排前面并标记`, () => {
    const out = merge([{ value: 'a' }], ['b']);
    assert.deepEqual(out.map((m) => m.value), ['a', 'b']);
    assert.equal(out[0].discovered, true);
    assert.equal(out[1].discovered, false);
  });

  test(`${name}:端点没列出的预设仍然保留`, () => {
    /* 有些中转不在 /v1/models 里公布全部模型,直接指定却能用。
       删掉等于替用户断定"这个不能用",而我们并不知道。 */
    const out = merge([{ value: 'a' }], ['secret-model']);
    assert.ok(out.some((m) => m.value === 'secret-model'));
  });

  test(`${name}:重复的只留一个,且以发现到的为准`, () => {
    const out = merge([{ value: 'x', label: '端点给的' }], [{ value: 'x', label: '内置的' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, '端点给的');
  });

  test(`${name}:空输入不炸`, () => {
    assert.deepEqual(merge([], []), []);
    assert.deepEqual(merge(undefined, undefined), []);
  });
}

/* ---------------------------------------------- 接线 */

test('查询要带上引擎环境前缀,否则密钥是空的', () => {
  /* 密钥在 ~/.remote-agent-env.sh 里。不 source 一遍,
     ${OPENAI_API_KEY} 就是空的 —— 结果永远 401,而且看着像密钥配错了。 */
  const main = read('electron/main.js');
  assert.match(main, /AGENT_ENV_PREFIX\} \$\{cmd\}/);
});

test('只缓存成功的结果', () => {
  /* 失败多半是暂时的(密钥刚配好、网络抖一下)。
     把失败缓存住,用户改完配置也要等 6 小时才生效,等于把人困住。 */
  const main = read('electron/main.js');
  assert.match(main, /if \(result\.ok\) modelCache\.set/);
});

test('发现失败时不打扰,静默退回内置清单', () => {
  /* 用户没要求这件事。因为它失败就弹个错误挡在面前,是喧宾夺主。 */
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /load\(false\)/);
  // 失败信息只在刷新按钮的 tooltip 里
  assert.match(chat, /自动获取模型列表失败/);
});

test('dsh 不查 —— 它没有 --model', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /const canDiscover = agent !== 'dsh'/);
});
