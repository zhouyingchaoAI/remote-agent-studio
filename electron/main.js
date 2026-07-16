const { app, BrowserWindow, ipcMain, dialog, screen, clipboard, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const { SSHManager } = require('./ssh/SSHManager');
const { ProxyService } = require('./ssh/ProxyService');
const { Installer } = require('./ssh/Installer');
const { AgentSession } = require('./ssh/AgentSession');
const { LocalExecutor } = require('./LocalExecutor');
const { AttachmentService } = require('./chat/AttachmentService');
const { createWorktree } = require('./git/WorktreeService');
const { buildLocalDirectoryManifest, buildRemoteDirectoryManifest } = require('./fileTransfer');
const {
  loadHosts, saveHosts, loadConvos, saveConvos, loadProxies, saveProxy,
  loadKnownHosts, saveKnownHost, loadSettings, saveSettings, loadTasks, saveTasks
} = require('./store');

let win;
const sessions = new Map(); // hostId -> {ssh, proxy, installer, agent}
const LOCAL_ID = 'local';

function getAttachmentService(session) {
  if (!session.attachments) {
    session.attachments = new AttachmentService(session.ssh, {
      cacheRoot: path.join(app.getPath('userData'), 'artifact-cache')
    });
  }
  return session.attachments;
}

function getSession(hostId) {
  // 本地项目模式:懒创建一个使用本机执行器的会话
  if (hostId === LOCAL_ID) {
    if (!sessions.has(LOCAL_ID)) {
      const lx = new LocalExecutor();
      sessions.set(LOCAL_ID, { ssh: lx, proxy: null, installer: new Installer(lx, null), agents: new Map(), local: true });
    }
    return sessions.get(LOCAL_ID);
  }
  const s = sessions.get(hostId);
  if (!s) throw new Error('主机未连接');
  return s;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    title: 'Remote Agent Studio',
    backgroundColor: '#0f1117',
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin' ? {
      titleBarOverlay: { color: '#0f1117', symbolColor: '#e4e8f1', height: 36 }
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });

  // 所有外链均通过受限的 shell:openExternal IPC 打开，渲染器不能自行跳转或创建子窗口。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  const revealWindow = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    const bounds = win.getBounds();
    const onScreen = screen.getAllDisplays().some(({ workArea }) => (
      bounds.x < workArea.x + workArea.width &&
      bounds.x + bounds.width > workArea.x &&
      bounds.y < workArea.y + workArea.height &&
      bounds.y + bounds.height > workArea.y
    ));
    if (!onScreen) win.center();
    win.setSkipTaskbar(false);
    win.show();
    win.focus();
    win.moveTop();
    win.setAlwaysOnTop(true, 'pop-up-menu');
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
    }, 500).unref();
  };

  win.once('ready-to-show', revealWindow);
  win.webContents.once('did-finish-load', revealWindow);
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`Renderer failed to load (${code}): ${description}`);
    revealWindow();
  });
  setTimeout(revealWindow, 1200).unref();
  if (process.env.VITE_DEV) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(() => {
  require('./logger').initLogger(app.getPath('userData'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

/** 剪贴板图片(截图)落盘为临时 PNG,供附件链路使用 */
ipcMain.handle('clipboard:saveImage', () => {
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return null;
  const dir = path.join(app.getPath('userData'), 'pasted-images');
  fs.mkdirSync(dir, { recursive: true });
  // 清理 7 天前的旧截图
  try {
    const cutoff = Date.now() - 7 * 86400 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.rmSync(fp, { force: true });
    }
  } catch (_) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = path.join(dir, `screenshot-${stamp}.png`);
  const buf = img.toPNG();
  fs.writeFileSync(filePath, buf);
  return { path: filePath, name: path.basename(filePath), size: buf.length };
});

/** 本机图片文件 -> 缩略图 data URL(附件发送前预览用) */
ipcMain.handle('fs:imageThumb', (_e, filePath) => {
  try {
    if (!filePath || fs.statSync(filePath).size > 25 * 1024 * 1024) return null;
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return null;
    const { width } = img.getSize();
    const thumb = width > 320 ? img.resize({ width: 320 }) : img;
    return thumb.toDataURL();
  } catch (_) { return null; }
});

ipcMain.handle('clipboard:readText', () => clipboard.readText());
ipcMain.handle('clipboard:writeText', (_event, text) => {
  clipboard.writeText(typeof text === 'string' ? text : '');
  return true;
});

/* ---------------- 应用设置 ---------------- */
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, s) => saveSettings(s));

/* ---------------- 主机配置 ---------------- */
ipcMain.handle('hosts:list', () => loadHosts());
ipcMain.handle('hosts:save', (_e, hosts) => { saveHosts(hosts); return true; });

/* ---------------- 连接管理 ---------------- */
/** TOFU 主机指纹校验:首次信任并记录;指纹变更时弹原生告警,需人工确认 */
function makeHostKeyVerifier(hostConfig, log) {
  const key = `${hostConfig.host}:${hostConfig.port || 22}`;
  return async (fingerprint) => {
    const known = loadKnownHosts()[key];
    if (!known) {
      saveKnownHost(key, fingerprint);
      log(`[安全] 首次连接,已记录主机指纹 ${fingerprint}\n`);
      return true;
    }
    if (known.fingerprint === fingerprint) return true;
    log(`[安全] ⚠️ 主机指纹变更!已记录: ${known.fingerprint} 当前: ${fingerprint}\n`);
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '主机指纹已变更',
      message: `${key} 的 SSH 主机指纹与上次连接不一致!`,
      detail: `这可能意味着服务器重装了系统,也可能是中间人攻击。\n\n已记录指纹:\n${known.fingerprint}\n\n本次指纹:\n${fingerprint}\n\n请确认服务器确实发生过变更后再信任。`,
      buttons: ['取消连接', '信任新指纹并继续'],
      defaultId: 0,
      cancelId: 0
    });
    if (r.response === 1) {
      saveKnownHost(key, fingerprint);
      log('[安全] 已信任新指纹\n');
      return true;
    }
    log('[安全] 已取消连接\n');
    return false;
  };
}

ipcMain.handle('ssh:connect', async (_e, hostConfig) => {
  const id = hostConfig.id;
  if (sessions.has(id)) sessions.get(id).ssh.disconnect();
  const logSetup = (t) => send('setup:log', { hostId: id, text: t });
  hostConfig = { ...hostConfig, verifyHostKey: makeHostKeyVerifier(hostConfig, logSetup) };
  const ssh = new SSHManager(hostConfig);
  const proxy = new ProxyService(ssh);
  const installer = new Installer(ssh, proxy);
  ssh.on('status', (st) => {
    send('ssh:status', { hostId: id, ...st });
    send('setup:log', { hostId: id, text: `[SSH] ${st.status}${st.detail ? ': ' + st.detail : ''}\n` });
  });
  sessions.set(id, { ssh, proxy, installer, agents: new Map(), hostConfig });
  await ssh.connect();
  // 连接成功后自动应用代理:有已保存配置就用它,否则用默认「局域网直连(本机当前IP:7890)」
  const log = (t) => send('setup:log', { hostId: id, text: t });
  let cfg = loadProxies()[id];
  if (!cfg) {
    cfg = { mode: 'direct', autoLanIp: true, port: 7890 };
    log('首次连接,自动应用默认代理:局域网直连(本机当前IP:7890)...\n');
    saveProxy(id, cfg);
  } else {
    log('恢复已保存的代理配置...\n');
  }
  if (cfg.mode && cfg.mode !== 'none') {
    try { await proxy.configure(await resolveProxyCfg(cfg, id), log); }
    catch (e) { log(`应用代理失败: ${e.message}(可到"环境配置"页手动调整)\n`); }
  }
  return true;
});

ipcMain.handle('ssh:disconnect', (_e, hostId) => {
  const s = sessions.get(hostId);
  if (s) { s.ssh.disconnect(); sessions.delete(hostId); }
  return true;
});

/* ---------------- 环境检测 / 安装 / 代理 ---------------- */
ipcMain.handle('setup:detect', async (_e, hostId) => getSession(hostId).installer.detect());

ipcMain.handle('setup:installAgent', async (_e, { hostId, agent }) => {
  const s = getSession(hostId);
  const log = (t) => send('setup:log', { hostId, text: t });
  return await s.installer.installAgent(agent, log);
});

ipcMain.handle('setup:setApiKey', async (_e, { hostId, agent, key }) => {
  const s = getSession(hostId);
  const log = (t) => send('setup:log', { hostId, text: t });
  await s.installer.setApiKey(agent, key, log);
  return true;
});

/** 本机认证文件下发到远程(codex: ~/.codex/auth.json 等) */
const AUTH_SYNC = {
  codex: [
    { rel: '.codex/auth.json', required: true, mode: '600' },
    { rel: '.codex/config.toml', required: false, mode: '644' }
  ],
  claude: [
    { rel: '.claude/.credentials.json', required: false, mode: '600' }
  ]
};

/** 检测本机 Codex 是否已配置(CLI 版本 + auth.json 有效性) */
ipcMain.handle('setup:detectLocalCodex', async () => {
  const { execFile } = require('child_process');
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  const result = { cliVersion: '', cliRunnable: false, hasAuth: false, authValid: false, account: '', authPath };

  // auth.json 检查
  if (fs.existsSync(authPath)) {
    result.hasAuth = true;
    try {
      const j = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      const hasKey = !!(j.OPENAI_API_KEY || j.openai_api_key);
      const tokens = j.tokens || j.token || {};
      const hasToken = !!(tokens.access_token || tokens.id_token || tokens.refresh_token);
      result.authValid = hasKey || hasToken;
      result.account = j.account_id || tokens.account_id ||
        (hasKey ? 'API Key' : (hasToken ? 'ChatGPT 登录' : ''));
      result.authType = hasKey ? 'apikey' : (hasToken ? 'chatgpt' : '');
      result.lastRefresh = j.last_refresh || tokens.last_refresh || '';
      // 从 id_token(JWT)解析套餐类型与过期时间(真实数据,不含"额度"数字)
      if (tokens.id_token) {
        try {
          const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString());
          const auth = payload['https://api.openai.com/auth'] || {};
          result.plan = auth.chatgpt_plan_type || auth.chatgpt_subscription_plan || payload.plan || '';
          result.email = payload.email || auth.email || '';
          if (payload.exp) result.tokenExpiry = new Date(payload.exp * 1000).toISOString();
        } catch (_) {}
      }
    } catch (_) { result.authValid = false; }
  }

  // 本机 codex CLI 版本(常见安装路径 + PATH)
  const candidates = [
    process.platform === 'win32' ? 'codex.cmd' : 'codex',
    process.platform === 'win32' ? 'codex.exe' : 'codex',
    'codex',
    path.join(os.homedir(), '.npm-global/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex'
  ];
  for (const bin of candidates) {
    try {
      const v = await new Promise((resolve) => {
        const command = process.platform === 'win32' && bin.endsWith('.cmd')
          ? (process.env.ComSpec || 'cmd.exe')
          : bin;
        const args = process.platform === 'win32' && bin.endsWith('.cmd')
          ? ['/d', '/s', '/c', bin, '--version']
          : ['--version'];
        execFile(command, args, { timeout: 5000, env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin:${os.homedir()}/.npm-global/bin` } },
          (err, stdout) => resolve(err ? '' : stdout.toString().trim()));
      });
      if (v) {
        result.cliVersion = v;
        result.cliRunnable = true;
        break;
      }
    } catch (_) {}
  }
  if (!result.cliVersion && process.platform === 'win32') {
    const installedPath = await new Promise((resolve) => {
      execFile('where.exe', ['codex.exe'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve('');
        const match = stdout.toString().split(/\r?\n/)
          .find((line) => /WindowsApps[\\/]+OpenAI\.Codex_/i.test(line));
        resolve(match || '');
      });
    });
    if (installedPath) {
      const version = installedPath.match(/OpenAI\.Codex_([^_\\/]+)/i)?.[1];
      result.cliVersion = `Codex Desktop${version ? ` ${version}` : ''}`;
    }
  }
  return result;
});

ipcMain.handle('setup:syncAuth', async (_e, { hostId, agent }) => {
  const s = getSession(hostId);
  const log = (t) => send('setup:log', { hostId, text: t });
  const files = AUTH_SYNC[agent] || [];
  const { stdout } = await s.ssh.exec('printf "__RAS_HOME__%s__RAS_HOME__" "$HOME"');
  const rhome = (String(stdout || '').match(/__RAS_HOME__([\s\S]*?)__RAS_HOME__/) || [])[1]?.trim() || '';
  if (!rhome) throw new Error('无法获取远程 HOME 目录');
  let synced = 0;
  for (const f of files) {
    const lp = path.join(os.homedir(), f.rel);
    if (!fs.existsSync(lp)) {
      if (f.required)
        throw new Error(`本机未找到 ~/${f.rel},请先在本机完成 ${agent} 登录(codex login)`);
      log(`跳过(本机不存在): ~/${f.rel}\n`);
      continue;
    }
    const rp = `${rhome}/${f.rel}`;
    const rdir = rp.slice(0, rp.lastIndexOf('/'));
    await s.ssh.exec(`mkdir -p '${rdir}'`);
    await s.ssh.upload(lp, rp);
    await s.ssh.exec(`chmod ${f.mode} '${rp}'`);
    log(`✓ 已下发 ~/${f.rel} → 远程 ${rp}\n`);
    synced++;
  }
  if (agent === 'claude' && synced === 0)
    log('未找到本机 Claude 认证文件(macOS 凭证保存在钥匙串中,无法直接复制)。\n建议:在下方写入 ANTHROPIC_API_KEY,或在「终端」页运行 claude 完成交互登录。\n');

  // 下发后自动做一次远程可用性测试
  if (synced > 0) {
    const t = await testRemoteAgent(s, agent, log);
    return { synced, test: t };
  }
  return { synced };
});

/** 在远程实际调用一次 agent,验证认证 + 网络是否可用 */
async function testRemoteAgent(s, agent, log) {
  const env = (s.proxy ? s.proxy.envPrefix() : '') +
    ' export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH";' +
    ' export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1;' +
    ' [ -s "$HOME/.remote-agent-node-env.sh" ] && . "$HOME/.remote-agent-node-env.sh";' +
    ' [ -s "$HOME/.remote-agent-env.sh" ] && . "$HOME/.remote-agent-env.sh";';
  log(`\n测试远程 ${agent} 可用性(实际调用一次,约 10-30 秒)...\n`);
  let cmd;
  if (agent === 'codex') {
    cmd = `${env} cd "$HOME" && codex exec --skip-git-repo-check --sandbox read-only ` +
      `'仅回复两个字:可用' 2>&1 </dev/null`;
  } else {
    cmd = `${env} cd "$HOME" && claude -p --permission-mode plan '仅回复两个字:可用' 2>&1 </dev/null`;
  }
  const r = await s.ssh.exec(cmd);
  const out = (r.stdout || '').trim();
  const lower = out.toLowerCase();
  const looksAuthErr = /unauthorized|not logged in|api key|401|403|login|authenticat/i.test(out);
  const looksNetErr = /tim(e|)out|network|connection|proxy|econn|getaddrinfo|dns/i.test(lower);
  const ok = r.code === 0 && !looksAuthErr && !looksNetErr;
  if (ok) {
    log(`✓ 远程 ${agent} 测试通过,认证与网络均正常。\n`);
    log(`  返回: ${out.slice(-200)}\n`);
    return { ok: true, output: out.slice(-500) };
  }
  log(`✗ 远程 ${agent} 测试未通过 (exit ${r.code})\n`);
  if (looksAuthErr) log('  疑似认证问题:请确认本机已登录且 auth.json 有效。\n');
  else if (looksNetErr) log('  疑似网络问题:请到上方重新「应用代理配置并测试」。\n');
  log(`  输出: ${out.slice(-400)}\n`);
  return { ok: false, output: out.slice(-500) };
}

ipcMain.handle('setup:testRemoteAgent', async (_e, { hostId, agent }) => {
  const s = getSession(hostId);
  const log = (t) => send('setup:log', { hostId, text: t });
  return await testRemoteAgent(s, agent, log);
});

ipcMain.handle('proxy:configure', async (_e, { hostId, cfg }) => {
  const s = getSession(hostId);
  const log = (t) => send('setup:log', { hostId, text: t });
  const r = await s.proxy.configure(await resolveProxyCfg(cfg, hostId), log);
  saveProxy(hostId, cfg); // 记住原始配置(autoLanIp 保持动态),下次连接自动恢复
  return r;
});

/** 返回本机局域网 IP(供 direct 模式自动填入/实时解析) */
function isPrivateIpv4(ip) {
  return /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function getAllLanIps() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) {
        ips.push(ni.address);
      }
    }
  }
  return ips;
}

async function getOutboundIp(targetHost) {
  if (!targetHost || targetHost === 'localhost' || targetHost === '127.0.0.1') return '';
  return await new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (ip = '') => {
      try { socket.close(); } catch (_) {}
      resolve(ip);
    };
    socket.once('error', () => done(''));
    socket.connect(9, targetHost, () => {
      try {
        const addr = socket.address();
        done(addr && addr.family === 'IPv4' ? addr.address : '');
      } catch (_) {
        done('');
      }
    });
    setTimeout(() => done(''), 1000).unref();
  });
}

async function getLanIp(hostId) {
  const ips = getAllLanIps();
  const targetHost = hostId && sessions.get(hostId)?.hostConfig?.host;
  const routedIp = await getOutboundIp(targetHost);
  const preferred = ips.includes(routedIp) ? routedIp : ips.find(isPrivateIpv4);
  return { ip: preferred || ips[0] || '', all: ips, routedIp, targetHost: targetHost || '' };
}

ipcMain.handle('net:lanIp', (_e, hostId) => getLanIp(hostId));

/**
 * 展开代理配置:direct 模式且 autoLanIp=true 时,每次都用"当前"本机 IP 现算,
 * 避免把会变的 IP 写死。
 */
async function resolveProxyCfg(cfg, hostId) {
  if (cfg && cfg.mode === 'direct' && cfg.autoLanIp) {
    const { ip } = await getLanIp(hostId);
    if (!ip) throw new Error('无法获取本机局域网 IP');
    return { ...cfg, directProxyUrl: `http://${ip}:${cfg.port || 7890}` };
  }
  return cfg;
}

/* ---------------- 对话历史持久化 ---------------- */
ipcMain.handle('convos:list', () => loadConvos());
ipcMain.handle('convos:save', (_e, convos) => { saveConvos(convos); return true; });
ipcMain.handle('tasks:list', () => loadTasks());
ipcMain.handle('tasks:save', (_e, tasks) => { saveTasks(tasks); return true; });
ipcMain.handle('worktrees:create', async (_e, fields) => {
  const session = getSession(fields?.hostId);
  return createWorktree(session.ssh, fields || {});
});

/* ---------------- Agent 对话(按 convId 隔离) ---------------- */
ipcMain.handle('agent:start', (_e, { hostId, convId, opts, resume }) => {
  const s = getSession(hostId);
  const existing = s.agents.get(convId);
  if (existing) existing.cancel();
  const agent = new AgentSession(s.ssh, s.proxy, opts);
  // 恢复上次会话的 resume 状态,实现跨重启续聊
  if (resume) {
    agent.claudeSessionId = resume.claudeSessionId || null;
    agent.codexSessionId = resume.codexSessionId || null;
    agent.codexStarted = !!resume.codexStarted;
  }
  agent.on('message', (msg) => {
    // 在每轮结束时附带最新 resume 状态,供渲染层持久化
    if (msg.kind === 'done') {
      msg.claudeSessionId = agent.claudeSessionId;
      msg.codexSessionId = agent.codexSessionId;
      msg.codexStarted = agent.codexStarted;
      msg.agent = agent.opts.agent; // 本轮实际执行的引擎
    }
    send('agent:message', { hostId, convId, msg });
  });
  s.agents.set(convId, agent);
  return true;
});

ipcMain.handle('agent:send', async (_e, { hostId, convId, messageId, prompt, attachments = [] }) => {
  const s = getSession(hostId);
  const agent = s.agents.get(convId);
  if (!agent) throw new Error('会话未初始化');
  const service = getAttachmentService(s);
  const turnId = messageId || `m_${Date.now()}`;
  const isLocal = hostId === LOCAL_ID;
  await service.validatePrepared({ convId, messageId: turnId, attachments, isLocal });
  const artifactDir = await service.ensureArtifactDir({ convId, messageId: turnId, isLocal });
  const result = await agent.send(prompt, { attachments, artifactDir });
  const artifacts = await service.listArtifacts({
    convId,
    messageId: turnId,
    extraPaths: result?.imagePaths || [],
    isLocal
  });
  for (const artifact of artifacts) {
    send('agent:message', {
      hostId,
      convId,
      msg: { kind: 'image', ...artifact }
    });
  }
  send('agent:message', {
    hostId,
    convId,
    msg: {
      kind: 'done',
      claudeSessionId: agent.claudeSessionId,
      codexSessionId: agent.codexSessionId,
      codexStarted: agent.codexStarted,
      agent: agent.opts.agent
    }
  });
  return true;
});

ipcMain.handle('agent:cancel', (_e, { hostId, convId }) => {
  const s = sessions.get(hostId);
  const agent = s?.agents.get(convId);
  if (agent) agent.cancel();
  return true;
});

/* ---------------- 文件传输 ---------------- */
ipcMain.handle('fs:listLocal', async (_e, dirPath) => {
  const p = dirPath || os.homedir();
  const dirents = await fs.promises.readdir(p, { withFileTypes: true });
  const entries = (await Promise.all(
    dirents
      .filter((e) => !e.name.startsWith('.') || dirPath) // 根目录默认隐藏点文件
      .map(async (e) => {
        let size = 0, mtime = 0;
        try { const st = await fs.promises.stat(path.join(p, e.name)); size = st.size; mtime = st.mtimeMs; } catch (_) {}
        return { name: e.name, isDir: e.isDirectory(), size, mtime };
      })
  )).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return { path: p, entries };
});

/* ---------------- 诊断信息导出 ---------------- */
ipcMain.handle('diag:export', async () => {
  const lines = [
    '# Remote Agent Studio 诊断信息',
    `时间: ${new Date().toISOString()}`,
    `应用版本: ${app.getVersion()}`,
    `Electron: ${process.versions.electron} / Node: ${process.versions.node} / Chrome: ${process.versions.chrome}`,
    `平台: ${process.platform} ${process.arch} (${os.release()})`,
    `已配置主机数: ${loadHosts().length}(不含凭据)`,
    `活动会话: ${[...sessions.keys()].join(', ') || '(无)'}`,
    ''
  ];
  // 附最近日志(最多 200 行)
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    const files = fs.readdirSync(logDir).sort();
    const latest = files[files.length - 1];
    if (latest) {
      const tail = fs.readFileSync(path.join(logDir, latest), 'utf8').split('\n').slice(-200).join('\n');
      lines.push(`## 最近日志 (${latest})`, '```', tail, '```');
    }
  } catch (_) { lines.push('(暂无日志)'); }
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), `remote-agent-diagnostics-${Date.now()}.md`)
  });
  if (r.canceled || !r.filePath) return { saved: false };
  fs.writeFileSync(r.filePath, lines.join('\n'), 'utf8');
  return { saved: true, path: r.filePath };
});

ipcMain.handle('fs:listRemote', async (_e, { hostId, dirPath }) => {
  // 本地项目模式:远程列表即本机列表
  if (hostId === LOCAL_ID) {
    let p = dirPath;
    if (!p || p === '~') p = os.homedir();
    else if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    const entries = fs.readdirSync(p, { withFileTypes: true }).map((e) => {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(p, e.name)); size = st.size; mtime = st.mtimeMs; } catch (_) {}
      return { name: e.name, isDir: e.isDirectory(), size, mtime };
    }).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    return { path: p, entries };
  }
  return getSession(hostId).ssh.listRemoteDir(dirPath);
});

ipcMain.handle('fs:upload', async (_e, { hostId, localPath, remotePath, transferId, resume }) => {
  const s = getSession(hostId);
  await s.ssh.upload(localPath, remotePath, (p) =>
    send('transfer:progress', { hostId, transferId, ...p }), transferId, { resume });
  return true;
});

ipcMain.handle('fs:uploadDirectory', async (_e, { hostId, localPath, remotePath, transferId }) => {
  const s = getSession(hostId);
  const manifest = await buildLocalDirectoryManifest(localPath);
  const madeDirectories = new Set();
  let completed = 0;
  await s.ssh.mkdirRemote(remotePath);

  for (const file of manifest.files) {
    const destination = path.posix.join(remotePath, file.relativePath);
    const parent = path.posix.dirname(destination);
    if (!madeDirectories.has(parent)) {
      await s.ssh.mkdirRemote(parent);
      madeDirectories.add(parent);
    }
    await s.ssh.upload(file.absolutePath, destination, ({ transferred }) => {
      send('transfer:progress', { hostId, transferId, transferred: completed + transferred, total: manifest.total });
    }, transferId);
    completed += file.size;
    send('transfer:progress', { hostId, transferId, transferred: completed, total: manifest.total });
  }
  return { files: manifest.files.length, skippedSymlinks: manifest.skippedSymlinks };
});

ipcMain.handle('fs:download', async (_e, { hostId, remotePath, localPath, transferId, resume }) => {
  const s = getSession(hostId);
  await s.ssh.download(remotePath, localPath, (p) =>
    send('transfer:progress', { hostId, transferId, ...p }), transferId, { resume });
  return true;
});

ipcMain.handle('fs:downloadDirectory', async (_e, { hostId, remotePath, localPath, transferId }) => {
  const s = getSession(hostId);
  const manifest = await buildRemoteDirectoryManifest((dir) => s.ssh.listRemoteDir(dir), remotePath);
  const localRoot = path.resolve(localPath);
  let completed = 0;
  await fs.promises.mkdir(localRoot, { recursive: true });

  for (const file of manifest.files) {
    const destination = path.resolve(localRoot, file.relativePath);
    if (destination !== localRoot && !destination.startsWith(localRoot + path.sep)) {
      throw new Error('远程目录包含无效路径');
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await s.ssh.download(file.remotePath, destination, ({ transferred }) => {
      send('transfer:progress', { hostId, transferId, transferred: completed + transferred, total: manifest.total });
    }, transferId);
    completed += file.size;
    send('transfer:progress', { hostId, transferId, transferred: completed, total: manifest.total });
  }
  return { files: manifest.files.length, skippedSymlinks: manifest.skippedSymlinks };
});

ipcMain.handle('fs:cancelTransfer', (_e, { hostId, transferId }) =>
  getSession(hostId).ssh.cancelTransfer(transferId));

/* 文件内容预览:文本截断到 512KB,图片最大 10MB,二进制给出提示 */
const PREVIEW_IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
const PREVIEW_MAX_TEXT = 512 * 1024;
const PREVIEW_MAX_IMAGE = 10 * 1024 * 1024;

ipcMain.handle('fs:readFile', async (_e, { hostId, filePath }) => {
  const ext = path.extname(filePath || '').toLowerCase();
  const mime = PREVIEW_IMAGE_EXT[ext];
  let buf, size, resolvedPath = filePath;

  if (hostId === LOCAL_ID) {
    let p = filePath;
    if (p === '~') p = os.homedir();
    else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
    resolvedPath = p;
    const st = fs.statSync(p);
    if (!st.isFile()) throw new Error('不是普通文件');
    size = st.size;
    if (mime && size > PREVIEW_MAX_IMAGE) throw new Error('图片超过 10 MB,请下载后查看');
    const cap = mime ? PREVIEW_MAX_IMAGE : PREVIEW_MAX_TEXT;
    const fd = fs.openSync(p, 'r');
    buf = Buffer.alloc(Math.min(size, cap));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
  } else {
    const s = getSession(hostId);
    const st = await s.ssh.statRemote(filePath);
    size = st.size;
    resolvedPath = st.path;
    if (mime && size > PREVIEW_MAX_IMAGE) throw new Error('图片超过 10 MB,请下载后查看');
    buf = await s.ssh.readRemoteFile(filePath, mime ? PREVIEW_MAX_IMAGE : PREVIEW_MAX_TEXT);
  }

  if (mime) {
    return { kind: 'image', name: path.basename(resolvedPath), path: resolvedPath, size, src: `data:${mime};base64,${buf.toString('base64')}` };
  }
  if (buf.subarray(0, 8192).includes(0)) {
    return { kind: 'binary', name: path.basename(resolvedPath), path: resolvedPath, size };
  }
  return {
    kind: 'text',
    name: path.basename(resolvedPath),
    path: resolvedPath,
    size,
    truncated: size > buf.length,
    content: buf.toString('utf8')
  };
});

ipcMain.handle('fs:mkdirRemote', async (_e, { hostId, remotePath }) =>
  getSession(hostId).ssh.mkdirRemote(remotePath));

ipcMain.handle('fs:deleteRemote', async (_e, { hostId, remotePath, isDir }) =>
  getSession(hostId).ssh.deleteRemote(remotePath, isDir));

ipcMain.handle('fs:saveText', async (_e, { defaultName, content }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), String(defaultName || 'export.md').replace(/[/\\]/g, '_'))
  });
  if (r.canceled || !r.filePath) return { saved: false };
  fs.writeFileSync(r.filePath, String(content ?? ''), 'utf8');
  return { saved: true, path: r.filePath };
});

ipcMain.handle('dialog:pickFile', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickFiles', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  return r.filePaths.map((filePath) => {
    const stat = fs.statSync(filePath);
    return { path: filePath, name: path.basename(filePath), size: stat.size };
  });
});

ipcMain.handle('attachments:prepare', async (_e, payload) => {
  const session = getSession(payload.hostId);
  return getAttachmentService(session).prepare({
    ...payload,
    isLocal: payload.hostId === LOCAL_ID
  });
});

ipcMain.handle('attachments:resolveImage', async (_e, payload) => {
  const session = getSession(payload.hostId);
  return getAttachmentService(session).resolveImage({
    ...payload,
    isLocal: payload.hostId === LOCAL_ID
  });
});

ipcMain.handle('attachments:cleanup', async (_e, { hostId, convId }) => {
  const session = getSession(hostId);
  await getAttachmentService(session).cleanupConversation({
    hostId,
    convId,
    isLocal: hostId === LOCAL_ID
  });
  return true;
});

ipcMain.handle('dialog:pickKeyFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'showHiddenFiles'],
    defaultPath: path.join(os.homedir(), '.ssh')
  });
  return r.canceled ? null : r.filePaths[0];
});

/* ---------------- 终端(多标签,按 termId 区分) ---------------- */
function wireTerm(hostId, termId, stream) {
  if (stream.__wired) return;
  stream.__wired = true;
  stream.on('data', (d) => send('term:data', { hostId, termId, data: d.toString('base64') }));
  stream.stderr?.on('data', (d) => send('term:data', { hostId, termId, data: d.toString('base64') }));
  stream.on('close', () => send('term:closed', { hostId, termId }));
}

ipcMain.handle('term:open', async (_e, { hostId, termId = 'default', cols, rows }) => {
  const s = getSession(hostId);
  const stream = await s.ssh.openShell({ termId, cols, rows });
  wireTerm(hostId, termId, stream);
  return true;
});
// 关闭并重建终端(用于加载最新代理/环境)
ipcMain.handle('term:reconnect', async (_e, { hostId, termId = 'default', cols, rows }) => {
  const s = getSession(hostId);
  s.ssh.closeShell(termId);
  await new Promise((r) => setTimeout(r, 200));
  const stream = await s.ssh.openShell({ termId, cols, rows });
  wireTerm(hostId, termId, stream);
  return true;
});
ipcMain.handle('term:close', (_e, { hostId, termId = 'default' }) => {
  const s = sessions.get(hostId);
  if (s) s.ssh.closeShell(termId);
  return true;
});
ipcMain.handle('term:write', (_e, { hostId, termId = 'default', data }) => { getSession(hostId).ssh.writeShell(termId, data); return true; });
ipcMain.handle('term:resize', (_e, { hostId, termId = 'default', cols, rows }) => { getSession(hostId).ssh.resizeShell(termId, cols, rows); return true; });
