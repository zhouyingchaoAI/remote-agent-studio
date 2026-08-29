const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const w = require('../electron/watchTargets');
const bg = require('../electron/bgTasks');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ---------------------------------------------- 从对话里认出该盯什么 */

test('systemctl 的单元名要扫完整段,不是取第一个词', () => {
  /* `systemctl daemon-reload && systemctl restart --no-block ragflow-bootstrap`
     取第一个非空词得到的是 daemon-reload(动词),真正的单元名反而漏了 ——
     而那正是要盯的那个。 */
  const u = w.extractUnits('systemctl daemon-reload && systemctl restart --no-block ragflow-bootstrap');
  assert.deepEqual(u, ['ragflow-bootstrap.service']);
});

test('四种写法都要认', () => {
  assert.deepEqual(w.extractUnits('add /etc/systemd/system/qwen36-w8a8-download.service'),
    ['qwen36-w8a8-download.service']);
  assert.ok(w.extractUnits('journalctl -u ragflow-bootstrap.service -n 35').includes('ragflow-bootstrap.service'));
  assert.ok(w.extractUnits('systemctl --no-pager --full status qwen7b-vllm.service').includes('qwen7b-vllm.service'));
  assert.ok(w.extractUnits('systemctl enable --now foo').includes('foo.service'));
});

test('子命令和选项不会被当成单元名', () => {
  // 否则每条命令都会往清单里塞几个假目标,面板很快又变回一锅粥
  const u = w.extractUnits('systemctl daemon-reload');
  assert.deepEqual(u, []);
  assert.ok(!w.extractUnits('journalctl -u x.service -n 35 --no-pager').includes('35.service'));
});

test('认出脚本名 —— nohup 起的那种不属于任何服务', () => {
  const s = w.extractScripts('nohup /usr/local/bin/ragflow-pull-retry.sh >/var/log/x.log 2>&1 &');
  assert.deepEqual(s, ['ragflow-pull-retry.sh']);
});

test('认出镜像名和 compose 项目名', () => {
  assert.ok(w.extractImages('docker pull edwardelric233/ragflow:oc9').includes('edwardelric233/ragflow:oc9'));
  // compose 没有镜像名,但项目名足够在 ps 里把进程认出来
  assert.ok(w.extractImages('docker compose -p ragflow pull').includes('ragflow'));
});

test('认出下载目标目录,但不碰系统目录', () => {
  assert.ok(w.extractPaths('git clone --depth 1 https://h/x /home/models/Q').includes('/home/models/Q'));
  assert.ok(w.extractPaths('wget -c -P /home/models/x https://a/b').includes('/home/models/x'));
  // du 一个系统目录既没意义又可能很慢,还会把整轮扫描拖超时
  assert.deepEqual(w.extractPaths('cp /usr/lib/x /etc/y'), []);
});

/* ------------------------------------------------------ 清单本身 */

test('同一目标再次出现会刷新时间,不会重复堆积', () => {
  const wl = new w.WatchList();
  wl.addFromCommand('systemctl restart foo', { now: 0 });
  wl.addFromCommand('journalctl -u foo.service', { now: 1000 });
  assert.equal(wl.size, 1);
});

test('过期的目标会被丢掉', () => {
  /* 一轮对话可能敲上百条命令,绝大多数是查状态这类一次性的。
     不过期的话,面板迟早又会变成一锅粥 —— 那正是这次重做要解决的。 */
  const wl = new w.WatchList({ ttlMs: 1000 });
  wl.addFromCommand('systemctl restart foo', { now: 0 });
  assert.deepEqual(wl.list('units', { now: 500 }), ['foo.service']);
  assert.deepEqual(wl.list('units', { now: 5000 }), []);
});

test('目标数量有上限,留最近的', () => {
  const wl = new w.WatchList({ max: 3 });
  // 名字要够长:太短的词不当单元名(挡住把选项碎片当成目标)
  for (let i = 0; i < 10; i += 1) wl.addFromCommand(`systemctl start svc${i}`, { now: i });
  assert.equal(wl.size, 3);
  // list 默认按当前时间判过期,这里造的时间戳是 0..9,必须显式传 now
  assert.ok(wl.list('units', { now: 9 }).includes('svc9.service'));
});

/* ------------------------------------------------------ 扫描范围 */

test('扫描只列对话点过名的进程', () => {
  /* 全机扫描那一版是错的方向:该看的漏(nohup 脚本)、
     不该看的一堆(auditd/mdmonitor)。取景框必须由对话划定。 */
  const cmd = bg.buildScanCommand({ tokens: ['ragflow-pull-retry.sh', 'ragflow'] });
  assert.match(cmd, /\*'ragflow-pull-retry\.sh'\*\|\*'ragflow'\*\) long=0/);
  assert.match(cmd, /\*\) continue ;;/);
});

test('一个目标都没有时,一条进程也不列', () => {
  // 宁可空着,也不要回到"满屏系统服务、真正在下的看不见"那个状态
  const out = execFileSync('bash', ['-c', bg.buildScanCommand()], {
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000
  }).toString();
  assert.equal(out.split('\n').filter((l) => l.startsWith('TASK')).length, 0);
});

test('没有目标单元时不生成 systemd 段 —— 空的 while read 会死锁', () => {
  /* 曾经在这里留了个 `while read -r u; do :` 当空分支。
     没有管道输入的 while read 会去读 stdin 然后永远挂住,整轮扫描直接死锁。
     **空分支比缺分支危险得多。** */
  const empty = bg.buildScanCommand();
  assert.ok(!/while read -r u/.test(empty), '不该生成读不到东西的 while read');
  assert.match(bg.buildScanCommand({ extraUnits: ['a.service'] }), /while read -r u/);
});

test('扫描不会挂住,两种情况都立刻返回', () => {
  for (const opts of [{}, { tokens: ['node'], extraUnits: ['a.service'], watchPaths: ['/tmp'] }]) {
    assert.doesNotThrow(() => execFileSync('bash', ['-c', bg.buildScanCommand(opts)], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000
    }), `参数 ${JSON.stringify(opts)} 下挂住了`);
  }
});

test('监控目标来自智能体转发的消息,不是另起一套上报', () => {
  // 那是唯一一个所有引擎、所有对话都必经的地方,挂在别处一定会漏
  const main = read('electron/main.js');
  assert.match(main, /function noteAgentActivity\(hostId, msg\)/);
  assert.ok((main.match(/noteAgentActivity\(hostId, msg\)/g) || []).length >= 2);
  assert.match(main, /tokens: \[\.\.\.wl\.list\('scripts'\), \.\.\.wl\.list\('images'\)\]/);
});
