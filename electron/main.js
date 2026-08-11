const { app, BrowserWindow, ipcMain, dialog, screen, clipboard, shell, nativeImage, globalShortcut, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const { SSHManager, shellQuote } = require('./ssh/SSHManager');
const { ProxyService } = require('./ssh/ProxyService');
const { Installer } = require('./ssh/Installer');
const { AgentSession } = require('./ssh/AgentSession');
const { deepseekEnvPosix, DEEPSEEK_DEFAULT_MODEL } = require('./ssh/deepseek');
const { GROK_DEFAULT_MODEL, parseGrokSpec } = require('./ssh/grokProviders');
const { LocalExecutor } = require('./LocalExecutor');
const { AttachmentService } = require('./chat/AttachmentService');
const stt = require('./stt');
const prismflow = require('./prismflow');
const obsidian = require('./obsidian');
const obsidianNotes = require('./obsidianNotes');
const obsidianGraph = require('./obsidianGraph');
const autoCapture = require('./autoCapture');
const claudeKeychain = require('./claudeKeychain');
const cliSessions = require('./cliSessions');
const skillsService = require('./skillsService');
const skillsMarket = require('./skillsMarket');
const { lintSkill, ENGINE_SKILL_DIRS } = require('./skills');
const { interpretVoiceCommand } = require('./voice');
const { captureRegion } = require('./screenshot');

const DEFAULT_SCREENSHOT_SHORTCUT = 'CommandOrControl+Shift+2';
const {
  loadHosts, saveHosts, loadConvos, saveConvos, loadProxies, saveProxy,
  loadKnownHosts, saveKnownHost, loadSettings, saveSettings,
  loadBrief, saveBrief, listBriefDates
} = require('./store');
const {
  buildBriefPrompt, extractBriefJson, normalizeBrief, isBriefEmpty, todayKey
} = require('./brief');

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
      nodeIntegration: false
    }
  });

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
  // 麦克风权限(语音输入):放行 media,其余保持默认允许(应用为本地可信环境)
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));

  if (process.env.VITE_DEV) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

/** 自动更新:仅打包版启用;GitHub Releases 通道;任何失败静默(不打扰用户) */
function initAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', (info) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      dialog.showMessageBox(win, {
        type: 'info',
        message: `新版本 ${info.version} 已下载`,
        detail: '重启应用即可完成更新。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0
      }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
    });
    autoUpdater.on('error', () => {}); // 网络/未发布版本等,静默
    autoUpdater.checkForUpdates().catch(() => {});
    // 之后每 6 小时检查一次
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  } catch (_) { /* electron-updater 未安装(源码运行)时跳过 */ }
}

app.whenReady().then(() => {
  require('./logger').initLogger(app.getPath('userData'));
  stt.init(app, safeStorage);
  prismflow.init(app, safeStorage);
  obsidian.init(app, safeStorage);
  autoCapture.init(app, { runDigest: runDailyDigest });
  autoCapture.start();
  createWindow();
  initAutoUpdater();
  registerScreenshotShortcut();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('will-quit', () => globalShortcut.unregisterAll());
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

/* ---------------- 语音转写(STT) ---------------- */
// 语音指令解释(确认/取消/选项号);放主进程以免 preload 触碰沙箱禁止的相对 require
ipcMain.handle('voice:interpret', (_e, { transcript, ctx } = {}) => interpretVoiceCommand(transcript, ctx));
ipcMain.handle('stt:getConfig', () => stt.getConfig());
ipcMain.handle('stt:setConfig', (_e, cfg) => stt.setConfig(cfg || {}));
ipcMain.handle('stt:transcribe', (_e, payload) => stt.transcribe(payload || {}));
// 简易连通性测试:发一段极短静音(足以触发鉴权/端点校验)
ipcMain.handle('stt:test', async () => {
  // 44 字节 WAV 头 + 极短静音
  const silent = Buffer.from(
    'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=', 'base64'
  );
  await stt.transcribe({ audioBase64: silent.toString('base64'), mimeType: 'audio/wav', filename: 'test.wav' });
  return { ok: true };
});

/* ---------------- 区域截图 ---------------- */
async function doCaptureScreenshot({ focusAfter = false } = {}) {
  const shot = await captureRegion(app, clipboard).catch(() => null);
  if (!shot) return null;
  send('screenshot:captured', shot);
  // 全局快捷键触发时应用多半在后台:截完拉到前台,让用户看到已加入对话
  if (focusAfter && win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  return shot;
}
ipcMain.handle('screenshot:capture', () => doCaptureScreenshot());

// 备选快捷键:默认键常被输入法/其它软件占用,依次降级
const SCREENSHOT_FALLBACKS = [
  'CommandOrControl+Shift+2',
  'CommandOrControl+Alt+A',
  'CommandOrControl+Shift+F1',
  'Alt+Shift+A'
];
let activeScreenshotShortcut = { accelerator: '', enabled: true, fallback: false, error: '' };

/**
 * 按设置注册截图全局快捷键。
 * register() 在快捷键被占用时返回 false 而不抛错,必须检查返回值,
 * 否则会出现"设置里写着快捷键、按下去却没反应"的静默失败。
 */
function registerScreenshotShortcut() {
  globalShortcut.unregisterAll();
  const s = loadSettings();
  if (s.screenshotShortcutEnabled === false) {
    activeScreenshotShortcut = { accelerator: '', enabled: false, fallback: false, error: '' };
    return activeScreenshotShortcut;
  }
  const preferred = s.screenshotShortcut || DEFAULT_SCREENSHOT_SHORTCUT;
  const candidates = [preferred, ...SCREENSHOT_FALLBACKS.filter((k) => k !== preferred)];
  for (const accel of candidates) {
    let ok = false;
    try { ok = globalShortcut.register(accel, () => doCaptureScreenshot({ focusAfter: true })); }
    catch (_) { ok = false; }
    if (ok && globalShortcut.isRegistered(accel)) {
      activeScreenshotShortcut = {
        accelerator: accel, enabled: true, fallback: accel !== preferred, error: ''
      };
      return activeScreenshotShortcut;
    }
  }
  activeScreenshotShortcut = {
    accelerator: '', enabled: true, fallback: false,
    error: `快捷键注册失败(${preferred} 及备选键均被占用,常见于输入法/截图工具抢占)。可在设置里换一个组合。`
  };
  return activeScreenshotShortcut;
}

/** 界面查询实际生效的快捷键(可能与设置里填的不同) */
ipcMain.handle('screenshot:shortcutStatus', () => activeScreenshotShortcut);

ipcMain.handle('clipboard:readText', () => clipboard.readText());
ipcMain.handle('clipboard:writeText', (_event, text) => {
  clipboard.writeText(typeof text === 'string' ? text : '');
  return true;
});

/* ---------------- 应用设置 ---------------- */
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, s) => {
  const saved = saveSettings(s);
  // 截图快捷键相关设置变更 → 重注册
  if (s && ('screenshotShortcut' in s || 'screenshotShortcutEnabled' in s)) registerScreenshotShortcut();
  return saved;
});

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

/** 图形界面:写入自定义 provider 的任意 env 变量(如中转站 key) */
ipcMain.handle('setup:setEnvKey', async (_e, { hostId, envKey, key }) => {
  const s = getSession(hostId);
  const log = (t) => send('setup:log', { hostId, text: t });
  await s.installer.setEnvKey(envKey, key, log);
  return true;
});

/** 图形界面:把当前国产模型配置(预设 + 自定义)同步写入远程 ~/.grok/config.toml */
ipcMain.handle('setup:syncGrokConfig', async (_e, { hostId }) => {
  const s = getSession(hostId);
  const log = (t) => send('setup:log', { hostId, text: t });
  await s.installer.ensureGrokConfig(loadSettings().grokModels || []);
  log('已同步国产模型配置到远程 ~/.grok/config.toml ✓\n');
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
  ],
  deepseek: [], // 无认证文件,走 DEEPSEEK_API_KEY(~/.remote-agent-env.sh)
  grok: []      // 国产模型走各家 env_key,无 xAI 认证文件可下发
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

/** 检测本机 Claude Code:CLI 版本 + 凭据来源(钥匙串/文件)+ 有效性 + 到期时间 */
ipcMain.handle('setup:detectLocalClaude', async () => {
  const { execFile } = require('child_process');
  const filePath = path.join(os.homedir(), '.claude', '.credentials.json');
  const result = {
    cliVersion: '', source: '', hasAuth: false, authValid: false, expired: false,
    expiresAt: 0, subscription: '', account: '', filePath, platform: process.platform
  };

  // 凭据:macOS 优先钥匙串,其次文件;Linux/Win 只有文件
  let credText = '';
  if (process.platform === 'darwin') {
    const cred = await claudeKeychain.exportCredentials();
    if (cred.ok) { credText = cred.text; result.source = 'keychain'; }
    else result.keychainError = cred.error;
  }
  if (!credText && fs.existsSync(filePath)) {
    try { credText = fs.readFileSync(filePath, 'utf8'); result.source = 'file'; } catch (_) {}
  }
  if (credText) {
    result.hasAuth = true;
    const s = claudeKeychain.summarizeCredentials(credText);
    result.authValid = s.valid && !s.expired;
    result.expired = s.expired;
    result.expiresAt = s.expiresAt;
    result.subscription = s.subscription;
    result.account = s.account;
  }

  // 本机 claude CLI 版本
  const candidates = [
    'claude',
    path.join(os.homedir(), '.npm-global/bin/claude'),
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ];
  for (const bin of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const v = await new Promise((resolve) => {
      execFile(bin, ['--version'], {
        timeout: 5000,
        env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin:${os.homedir()}/.npm-global/bin:${os.homedir()}/.local/bin` }
      }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
    });
    if (v) { result.cliVersion = v; break; }
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
  // macOS 上 Claude 凭据在钥匙串里(不是文件),需要先导出再下发。
  // 这样 Pro/Max 订阅登录态也能在远程用,不必额外买 API Key。
  if (agent === 'claude' && synced === 0 && process.platform === 'darwin') {
    log('本机没有凭据文件,尝试从 macOS 钥匙串导出 Claude 登录态...\n');
    const cred = await claudeKeychain.exportCredentials();
    if (cred.ok) {
      const rp = `${rhome}/.claude/.credentials.json`;
      await s.ssh.exec(`mkdir -p '${rhome}/.claude'`);
      // 经 base64 传输,避免 JSON 里的引号被 shell 吃掉
      const b64 = Buffer.from(cred.text, 'utf8').toString('base64');
      const r = await s.ssh.exec(
        `printf '%s' '${b64}' | base64 -d > '${rp}' && chmod 600 '${rp}' && echo OK`
      );
      if (!/OK/.test(r.stdout || '')) throw new Error('写入远程 .credentials.json 失败');
      synced++;
      log(`✓ 已从钥匙串导出并下发 → ${rp}(600 权限)\n`);
      if (cred.expiresAt) {
        const left = cred.expiresAt - Date.now();
        log(left > 0
          ? `  token 有效期至 ${new Date(cred.expiresAt).toLocaleString()}(约 ${Math.round(left / 3600000)} 小时后过期)\n`
          : '  ⚠️ 该 token 已过期,请在本机运行 claude 重新登录后再下发一次\n');
      }
    } else {
      log(`未能从钥匙串导出:${cred.error}\n` +
        '备选:在下方写入 ANTHROPIC_API_KEY,或在「终端」页运行 claude 完成交互登录。\n');
    }
  } else if (agent === 'claude' && synced === 0) {
    log('未找到本机 Claude 认证文件。\n建议:在下方写入 ANTHROPIC_API_KEY,或在「终端」页运行 claude 完成交互登录。\n');
  }

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
  } else if (agent === 'deepseek') {
    // claude CLI + DeepSeek Anthropic 兼容端点
    cmd = `${env} ${deepseekEnvPosix()} cd "$HOME" && ` +
      `claude -p --permission-mode plan --model '${DEEPSEEK_DEFAULT_MODEL}' '仅回复两个字:可用' 2>&1 </dev/null`;
  } else if (agent === 'grok') {
    // grok CLI + 国产模型自定义端点;先确保 config 受管块存在
    await s.installer.ensureGrokConfig(loadSettings().grokModels || []).catch(() => {});
    const alias = parseGrokSpec(GROK_DEFAULT_MODEL).alias;
    cmd = `${env} export PATH="$HOME/.grok/bin:$PATH"; cd "$HOME" && ` +
      `grok --output-format json -m '${alias}' --sandbox read-only -p '仅回复两个字:可用' 2>&1 </dev/null`;
  } else {
    // 默认用 opus 测试:CLI 的默认模型可能是账号已无额度的那个,
    // 会把「额度耗尽」误报成「认证/环境有问题」
    const model = loadSettings().claudeTestModel || 'opus';
    cmd = `${env} cd "$HOME" && claude -p --permission-mode plan --model ${shellQuote(model)} '仅回复两个字:可用' 2>&1 </dev/null`;
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
  if (/out of usage credits|usage limit|quota exceeded/i.test(out)) {
    log('  额度已用尽(不是认证问题,登录态是好的)。\n' +
      '  处理:换一个仍有额度的模型(对话页模型下拉,或用国产模型引擎),或为账号补充额度。\n');
  } else if (/OAuth session expired|could not be refreshed/i.test(out)) {
    log('  登录态已过期:请在本机运行一次 claude 确认仍是登录状态,然后回到这里重新点「下发 Claude 认证」。\n' +
      '  (订阅登录的 token 有有效期,过期后需要重新下发一次)\n');
  } else if (looksAuthErr) {
    log(agent === 'claude'
      ? '  疑似认证问题:macOS 的 Claude 凭据在钥匙串里,请点「下发 Claude 认证」自动导出;或改用 ANTHROPIC_API_KEY。\n'
      : '  疑似认证问题:请确认本机已登录且 auth.json 有效。\n');
  }
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

/* ---------------- 每日速览(Daily Brief) ---------------- */
ipcMain.handle('brief:get', (_e, { date } = {}) => loadBrief(date || todayKey()));
ipcMain.handle('brief:dates', () => listBriefDates());
ipcMain.handle('brief:today', () => todayKey());

let briefRunning = false;
/**
 * 跑一次速览:用一个临时 AgentSession 执行提示词,收集最终文本后解析成结构化数据。
 * 不写入任何对话记录,避免污染聊天历史。
 */
ipcMain.handle('brief:run', async (_e, { hostId, agent = 'codex', cwd = '', model = '', topics = '' } = {}) => {
  if (briefRunning) throw new Error('已有一次速览正在进行中');
  briefRunning = true;
  const date = todayKey();
  const progress = (text) => send('brief:progress', { text });
  try {
    const s = getSession(hostId);
    // 只读沙箱即可:速览只需要联网检索,不该改任何文件
    const session = new AgentSession(s.ssh, s.proxy, { agent, cwd, model, permissionMode: 'workspace' });
    if (agent === 'grok') {
      await s.installer.ensureGrokConfig(loadSettings().grokModels || []).catch(() => {});
    }

    let collected = '';
    session.on('message', (msg) => {
      if (msg.kind === 'text' || msg.kind === 'result') collected += `\n${msg.text || ''}`;
      else if (msg.kind === 'text_delta') collected += msg.text || '';
      // 把过程反馈给界面,长任务不至于像卡死
      if (msg.kind === 'tool') progress(`检索中:${msg.name || ''} ${String(msg.detail || '').slice(0, 80)}`);
      else if (msg.kind === 'status') progress(msg.text || '');
      else if (msg.kind === 'error' || msg.kind === 'stderr') progress(String(msg.text || '').slice(0, 200));
    });

    progress('正在让 agent 联网检索…');
    await session.send(buildBriefPrompt({ date, topics }));

    const parsed = extractBriefJson(collected);
    if (!parsed) {
      throw new Error('未能从模型输出里解析出结构化结果(可能是检索失败或输出被截断),可重试一次');
    }
    const sections = normalizeBrief(parsed);
    if (isBriefEmpty(sections)) {
      throw new Error('本次没有检索到有效内容,请稍后重试或检查远程网络/代理');
    }
    const payload = { date, generatedAt: Date.now(), agent, model, sections };
    saveBrief(date, payload);
    return payload;
  } finally {
    briefRunning = false;
  }
});

/* ---------------- PrismFlowAgent(开源资讯聚合)集成 ---------------- */
ipcMain.handle('prism:getConfig', () => prismflow.getConfig());
ipcMain.handle('prism:setConfig', (_e, cfg) => prismflow.setConfig(cfg || {}));
ipcMain.handle('prism:register', (_e, { name } = {}) => prismflow.register(name));
ipcMain.handle('prism:health', () => prismflow.health());
ipcMain.handle('prism:deployPrompt', (_e, opts) => prismflow.buildDeployPrompt(opts || {}));
ipcMain.handle('prism:capabilities', async () => {
  const data = await prismflow.discovery();
  return prismflow.extractCapabilities(data);
});
/** 执行流光的 agent/workflow;若输出是速览 JSON 则解析成卡片,否则原样返回文本 */
ipcMain.handle('prism:execute', async (_e, { action, id, input } = {}) => {
  const result = await prismflow.execute({ action, id, input });
  const text = prismflow.extractExecuteText(result);
  const parsed = extractBriefJson(text);
  const sections = parsed ? normalizeBrief(parsed) : null;
  return { text, sections: sections && !isBriefEmpty(sections) ? sections : null };
});
/** 把流光跑出来的结果存成当日速览 */
ipcMain.handle('prism:saveAsBrief', (_e, { sections, text, source } = {}) => {
  const date = todayKey();
  const payload = { date, generatedAt: Date.now(), agent: source || 'PrismFlowAgent', sections, text };
  saveBrief(date, payload);
  return payload;
});

/* ---------------- Obsidian 知识库 ---------------- */
ipcMain.handle('obsidian:getConfig', () => obsidian.getConfig());
ipcMain.handle('obsidian:setConfig', (_e, cfg) => obsidian.setConfig(cfg || {}));
ipcMain.handle('obsidian:test', () => obsidian.test());
ipcMain.handle('obsidian:pickVault', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 Obsidian vault 目录', properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return obsidian.setConfig({ vaultPath: r.filePaths[0] });
});

/**
 * 新建一个 vault:没用过 Obsidian 的人也能立刻开始积累。
 * 建出的目录含 .obsidian(Obsidian 据此识别 vault)与一篇说明笔记。
 */
ipcMain.handle('obsidian:createVault', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: '新建 Obsidian vault',
    defaultPath: path.join(app.getPath('documents'), '我的知识库'),
    buttonLabel: '创建'
  });
  if (r.canceled || !r.filePath) return null;
  const vaultPath = r.filePath;
  fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true });
  const cfg = obsidian.setConfig({ vaultPath });
  const folder = obsidian.sanitizeRelFolder(cfg.folder);
  fs.mkdirSync(path.join(vaultPath, folder), { recursive: true });
  // 放一篇起始笔记,图谱页立刻有内容,不至于开局一片空白
  const welcome = [
    '---', 'title: 知识库说明', 'tags:', '  - MOC', '---', '',
    '# 知识库说明', '',
    '这个库由 Remote Agent Studio 自动维护经验沉淀。', '',
    '## 它怎么工作', '',
    '- 对话页点 🧠 可把当前对话提炼成原子笔记',
    '- 开启「每日自动沉淀」后,每天定时把当天的可复用经验写进来',
    '- 已有笔记按日期**追加**补充,你手写的内容不会被覆盖',
    '- 同一概念复用相同标题并建立双向链接,图谱会随时间越长越密', '',
    // 注意:这里不要写 [[xxx]],否则新库开局就带一处断链,统计看着不健康
    '## 怎么看', '',
    '在「图谱」页可以查看与管理,重点看**孤立笔记**和**断链**两个数字。', ''
  ].join('\n');
  fs.writeFileSync(path.join(vaultPath, folder, '知识库说明.md'), welcome);
  return cfg;
});

/** 诊断:准确说清「为什么图谱是空的」,而不是笼统报错 */
ipcMain.handle('obsidian:diagnose', () => {
  const cfg = obsidian.getConfig();
  const out = { ...cfg, exists: false, isVault: false, folderExists: false, mdInVault: 0, mdInFolder: 0 };
  if (!cfg.vaultPath) return out;
  out.exists = fs.existsSync(cfg.vaultPath);
  if (!out.exists) return out;
  out.isVault = fs.existsSync(path.join(cfg.vaultPath, '.obsidian'));
  const folderPath = path.join(cfg.vaultPath, obsidian.sanitizeRelFolder(cfg.folder));
  out.folderExists = fs.existsSync(folderPath);
  out.mdInVault = obsidianGraph.collectMarkdown(cfg.vaultPath, { max: 200 }).length;
  out.mdInFolder = out.folderExists ? obsidianGraph.collectMarkdown(folderPath, { max: 200 }).length : 0;
  return out;
});

/* ------------------------------------------------------------------ 技能(Agent Skills)
 * SKILL.md 是跨引擎开放标准,同一份技能对 claude/codex/grok 都生效。
 * 远程主机默认是裸环境,一条技能都没有 —— 这里负责把它们装过去。 */

ipcMain.handle('skills:listBuiltin', () => skillsService.listBuiltin());

ipcMain.handle('skills:engineDirs', () => ENGINE_SKILL_DIRS);

/** 校验用户手写/粘贴的技能,给出可执行的改进建议 */
ipcMain.handle('skills:lint', (_e, { content } = {}) => lintSkill(content || ''));

/** 列出某主机某引擎下已安装的技能 */
ipcMain.handle('skills:listInstalled', async (_e, { hostId, engine } = {}) => {
  const { ssh } = getSession(hostId);
  return skillsService.listInstalled(ssh, engine || 'claude');
});

/** 下发:把选中的技能写入选中引擎的技能目录 */
ipcMain.handle('skills:install', async (_e, { hostId, engines, skills } = {}) => {
  const { ssh } = getSession(hostId);
  const log = (text) => win?.webContents.send('skills:log', { hostId, text });
  return skillsService.installSkills(ssh, { engines, skills, log });
});

ipcMain.handle('skills:remove', async (_e, { hostId, engine, name } = {}) => {
  const { ssh } = getSession(hostId);
  return skillsService.removeSkill(ssh, engine, name);
});

/* -- 技能市场:运行时从上游仓库拉取,不把上游代码 vendor 进本仓库 -- */

ipcMain.handle('skills:marketSources', () => skillsMarket.SOURCES);

ipcMain.handle('skills:marketList', async (_e, { repo, branch } = {}) => {
  const spec = skillsMarket.parseRepoSpec(repo || '');
  if (!spec) throw new Error('仓库格式应为 owner/repo');
  return skillsMarket.listSource({ repo: spec, branch: branch || 'main' });
});

ipcMain.handle('skills:marketFetch', async (_e, { repo, path: p, branch } = {}) => {
  const spec = skillsMarket.parseRepoSpec(repo || '');
  if (!spec) throw new Error('仓库格式应为 owner/repo');
  const content = await skillsMarket.fetchSkillContent({ repo: spec, path: p, branch: branch || 'main' });
  return { content, ...lintSkill(content) };
});

/** 把每日速览归档成一篇笔记 */
ipcMain.handle('obsidian:saveBrief', async (_e, { date } = {}) => {
  const brief = loadBrief(date || todayKey());
  if (!brief) throw new Error('没有可归档的速览');
  const cfg = obsidian.getConfig();
  const rel = obsidian.notePath(cfg.folder, `AI 速览 ${brief.date}`);
  await obsidian.writeNote(rel, obsidianNotes.renderBriefNote(brief));
  return { path: rel };
});

/**
 * 把对话提炼成原子笔记并写入知识库:
 * 用当前引擎跑一次抽取(输出 JSON),再渲染成带双链的笔记 + 更新 MOC。
 */
ipcMain.handle('obsidian:saveFromConversation', async (_e, { hostId, agent = 'codex', cwd = '', model = '', content, topic } = {}) => {
  if (!String(content || '').trim()) throw new Error('没有可提炼的内容');
  const s = getSession(hostId);
  const session = new AgentSession(s.ssh, s.proxy, { agent, cwd, model, permissionMode: 'workspace' });
  if (agent === 'grok') await s.installer.ensureGrokConfig(loadSettings().grokModels || []).catch(() => {});

  let collected = '';
  session.on('message', (msg) => {
    if (msg.kind === 'text' || msg.kind === 'result') collected += `\n${msg.text || ''}`;
    else if (msg.kind === 'text_delta') collected += msg.text || '';
    else if (msg.kind === 'status') send('obsidian:progress', { text: msg.text || '' });
  });
  send('obsidian:progress', { text: '正在提炼原子笔记…' });
  await session.send(obsidianNotes.buildExtractPrompt({ content, topic }));

  const parsed = obsidianNotes.parseNotesJson(collected);
  if (!parsed) throw new Error('未能从模型输出解析出笔记结构,可重试一次');
  const { notes, moc } = obsidianNotes.normalizeNotes(parsed);
  if (!notes.length) throw new Error('没有提炼出有效笔记');

  send('obsidian:progress', { text: `正在写入 ${notes.length} 篇笔记…` });
  const rendered = notes.map((n) => ({ ...n, content: obsidianNotes.renderNote({ ...n, source: `对话 · ${agent}` }) }));
  const result = await obsidian.saveNotes({ notes: rendered, mocName: moc });
  return { ...result, count: rendered.length, mocName: moc };
});

/* ---------------- Obsidian 知识图谱 ---------------- */
ipcMain.handle('obsidian:graph', (_e, { scope = 'vault' } = {}) => {
  const cfg = obsidian.getConfig();
  // scope=folder 只看本工具的落地目录,vault 则看整个库
  return obsidianGraph.scanVault(cfg.vaultPath, {
    subFolder: scope === 'folder' ? obsidian.sanitizeRelFolder(cfg.folder) : ''
  });
});

/** 按相对路径读一篇笔记(路径经 vault 边界校验) */
ipcMain.handle('obsidian:readNoteFile', (_e, { relPath } = {}) => {
  const cfg = obsidian.getConfig();
  if (!cfg.vaultPath) throw new Error('未配置 vault');
  const abs = obsidian.assertInsideVault(cfg.vaultPath, path.join(cfg.vaultPath, relPath || ''));
  return { relPath, content: fs.readFileSync(abs, 'utf8') };
});

/** 删除笔记(移到系统废纸篓,避免误删不可恢复) */
ipcMain.handle('obsidian:deleteNote', async (_e, { relPath } = {}) => {
  const cfg = obsidian.getConfig();
  if (!cfg.vaultPath) throw new Error('未配置 vault');
  const abs = obsidian.assertInsideVault(cfg.vaultPath, path.join(cfg.vaultPath, relPath || ''));
  await shell.trashItem(abs);   // 进废纸篓而不是直接 rm
  return { ok: true };
});

/** 在 Obsidian 里打开该笔记 */
ipcMain.handle('obsidian:openInApp', (_e, { relPath } = {}) => {
  const cfg = obsidian.getConfig();
  if (!cfg.vaultPath) throw new Error('未配置 vault');
  const vaultName = path.basename(cfg.vaultPath);
  const file = String(relPath || '').replace(/\.md$/i, '');
  shell.openExternal(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`);
  return { ok: true };
});

/* ---------------- 每日自动沉淀(无感知积累经验) ---------------- */

/** 把一段对话压成纯文本(只保留有信息量的部分) */
function conversationToText(conv) {
  const lines = [];
  for (const m of conv.messages || []) {
    if (m.role === 'user') lines.push(`【我】${m.text || ''}`);
    else if (m.kind === 'text' || m.kind === 'result') lines.push(`【${conv.agent || 'agent'}】${m.text || ''}`);
    else if (m.kind === 'tool') lines.push(`[工具] ${m.name || ''} ${String(m.detail || '').slice(0, 200)}`);
    else if (m.kind === 'error') lines.push(`[错误] ${String(m.text || '').slice(0, 200)}`);
  }
  return lines.filter(Boolean).join('\n');
}

/** 当天有实质产出的对话才值得沉淀:有来回、有工具动作或足够长度 */
function pickConversationsForDigest(convos, date) {
  const start = new Date(`${date}T00:00:00`).getTime();
  const end = start + 86400000;
  return (convos || [])
    .filter((c) => {
      const t = c.updatedAt || 0;
      if (t < start || t >= end) return false;
      const msgs = c.messages || [];
      const userTurns = msgs.filter((m) => m.role === 'user').length;
      const hasTool = msgs.some((m) => m.kind === 'tool' || m.kind === 'diff');
      const text = conversationToText(c);
      return userTurns >= 1 && (hasTool || text.length > 600);
    })
    .map((c) => ({ title: c.title, content: conversationToText(c) }));
}

/** 单批回溯的字符预算:太大容易被模型截断,太小又浪费调用次数 */
const BACKFILL_CHARS_PER_BATCH = 20000;

/** 全部历史对话(按时间正序,老的先沉淀,后面的才能链到前面) */
function pickAllConversations() {
  return (loadConvos() || [])
    .filter((c) => {
      const msgs = c.messages || [];
      const userTurns = msgs.filter((m) => m.role === 'user').length;
      const hasTool = msgs.some((m) => m.kind === 'tool' || m.kind === 'diff');
      return userTurns >= 1 && (hasTool || conversationToText(c).length > 400);
    })
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
    .map((c) => ({ title: c.title, content: conversationToText(c) }));
}

/** 每日汇总任务:抽取 -> 合并入库(供定时器与「立即运行」共用) */
async function runDailyDigest({ date, cfg }) {
  const obsCfg = obsidian.getConfig();
  if (obsCfg.transport === 'file' && !obsCfg.vaultPath) throw new Error('未配置 Obsidian vault 路径');

  const conversations = pickConversationsForDigest(loadConvos(), date);
  if (conversations.length < (cfg.minConversations || 1)) {
    return { count: 0, created: 0, merged: 0, note: '当天没有值得沉淀的对话' };
  }

  const s = getSession(cfg.hostId || 'local');
  await s.installer.ensureGrokConfig(loadSettings().grokModels || []).catch(() => {});
  // 定时任务同样自动挑可用引擎:半夜跑失败没人看得到,不能因为配置过期就白跑
  const picked = await pickWorkingExtractor(s, { preferred: cfg.agent, model: cfg.model });
  if (!picked.agent) {
    throw new Error(`没有可用的抽取引擎:${picked.tried.join('; ')}`);
  }
  const agent = picked.agent;
  const session = new AgentSession(s.ssh, s.proxy, {
    agent, cwd: '', model: picked.model || '', permissionMode: 'workspace'
  });

  let collected = '';
  session.on('message', (msg) => {
    if (msg.kind === 'text' || msg.kind === 'result') collected += `\n${msg.text || ''}`;
    else if (msg.kind === 'text_delta') collected += msg.text || '';
  });

  await session.send(obsidianNotes.buildDailyExtractPrompt({
    date, conversations, existingTitles: obsidian.listExistingTitles()
  }));

  const parsed = obsidianNotes.parseNotesJson(collected);
  if (!parsed) throw new Error('未能解析出笔记结构');
  const { notes, moc } = obsidianNotes.normalizeNotes(parsed);
  if (!notes.length) return { count: 0, created: 0, merged: 0, note: '模型判断当天无可沉淀内容' };

  const r = await obsidian.saveNotesMerging({ notes, mocName: moc, date, source: `每日沉淀 · ${agent}` });
  send('autocapture:done', { date, count: notes.length, created: r.created, merged: r.merged });
  return { count: notes.length, created: r.created, merged: r.merged, moc: r.moc };
}

/** 开启前自检:把「会不会静默失败」提前暴露出来 */
ipcMain.handle('autocapture:check', async () => {
  const cfg = autoCapture.getConfig();
  const obs = obsidian.getConfig();
  const out = { vault: false, cli: false, host: cfg.hostId || 'local', agent: cfg.agent, model: cfg.model, notes: [] };

  // 1) vault 可写
  if (obs.transport === 'rest') out.vault = !!obs.hasKey;
  else out.vault = !!obs.vaultPath && fs.existsSync(obs.vaultPath);
  if (!out.vault) out.notes.push('未配置知识库(vault)——到图谱页或设置里先选一个');

  // 2) 抽取引擎的 CLI 在目标主机上是否可用
  try {
    const s = getSession(out.host);
    const env = await s.installer.detect();
    const need = { codex: env.codex, claude: env.claude, deepseek: env.claude, grok: env.grok }[out.agent];
    out.cli = !!need;
    out.cliVersion = need || '';
    if (!need) {
      out.notes.push(`主机「${out.host}」上没有 ${out.agent === 'grok' ? 'grok' : out.agent} CLI——去环境配置页安装,或换一个已装好的引擎`);
    }
  } catch (e) {
    out.notes.push(`连不上主机「${out.host}」:${String(e?.message || e).slice(0, 120)}`);
  }

  out.ok = out.vault && out.cli;
  if (out.ok) out.notes.push('前置条件齐全,可以开启');
  return out;
});

/**
 * 一键初始化知识库:没配 vault 就自动建一个,省掉所有中间步骤。
 * 之前的流程要「选目录 → 回溯 → 开自动沉淀」三步,用户很容易卡在第一步。
 */
ipcMain.handle('obsidian:quickStart', () => {
  const cfg = obsidian.getConfig();
  if (cfg.vaultPath && fs.existsSync(cfg.vaultPath)) return { ...cfg, created: false };

  // 默认建在「文稿/我的知识库」,不弹窗;想换位置可到设置里改
  let base = path.join(app.getPath('documents'), '我的知识库');
  let n = 1;
  while (fs.existsSync(base)) { base = path.join(app.getPath('documents'), `我的知识库-${++n}`); }
  fs.mkdirSync(path.join(base, '.obsidian'), { recursive: true });
  const next = obsidian.setConfig({ vaultPath: base });
  const folder = obsidian.sanitizeRelFolder(next.folder);
  fs.mkdirSync(path.join(base, folder), { recursive: true });
  fs.writeFileSync(path.join(base, folder, '知识库说明.md'), [
    '---', 'title: 知识库说明', 'tags:', '  - MOC', '---', '',
    '# 知识库说明', '',
    '本库由 Remote Agent Studio 自动维护:把对话里的可复用经验沉淀成原子笔记,',
    '同一概念复用相同标题并互相链接,图谱会随时间越长越密。', '',
    '- 已有笔记按日期追加补充,手写内容不会被覆盖',
    '- 在「图谱」页可查看与管理,重点看孤立笔记与断链两个数字', ''
  ].join('\n'));
  return { ...next, created: true, vaultPath: base };
});

/** 收集所有来源:应用对话 + 本机 CLI 会话 + 已连接远程主机上的 CLI 会话 */
async function gatherAllSources({ includeCliSessions = true, includeRemote = true } = {}) {
  const convos = pickAllConversations();
  const local = includeCliSessions ? cliSessions.scanLocalSessions() : [];

  // 远程只列文件不取内容 —— 内容在回溯时分页拉,避免一次几十 MB 压垮 SSH
  const remoteFiles = [];
  if (includeRemote) {
    for (const [hostId, s] of sessions.entries()) {
      if (hostId === LOCAL_ID || !s?.ssh || s.ssh.status !== 'connected') continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const files = await cliSessions.listRemoteSessionFiles((cmd) => s.ssh.exec(cmd));
        remoteFiles.push(...files.map((f) => ({ ...f, hostId })));
      } catch (_) { /* 单台失败不影响其它 */ }
    }
  }
  return { convos, local, remoteFiles };
}

/** 预估:全量回溯会处理哪些来源、多少字 */
ipcMain.handle('autocapture:backfillEstimate', async (_e, opts = {}) => {
  const { convos, local, remoteFiles } = await gatherAllSources(opts);
  const localSum = cliSessions.summarize(local);
  // 远程按文件大小估算(还没取内容),解析后通常会小不少
  const remoteBytes = remoteFiles.reduce((n, f) => n + Math.min(f.size, 400000), 0);
  const remoteProjects = new Set(remoteFiles.map((f) => cliSessions.projectFromRemotePath(f.file)));
  const chars = convos.reduce((n, c) => n + c.content.length, 0) + localSum.chars + remoteBytes;
  return {
    conversations: convos.length,
    cliSessions: localSum.sessions,
    remoteSessions: remoteFiles.length,
    projects: localSum.projects + remoteProjects.size,
    topProjects: [
      ...localSum.topProjects,
      ...[...remoteProjects].slice(0, 8).map((project) => ({
        project, count: remoteFiles.filter((f) => cliSessions.projectFromRemotePath(f.file) === project).length
      }))
    ].sort((a, b) => b.count - a.count).slice(0, 10),
    chars,
    batches: Math.max(1, Math.ceil(chars / BACKFILL_CHARS_PER_BATCH))
  };
});

/**
 * 全量回溯沉淀:把**所有历史对话**提炼进知识库。
 * 分批处理(按字符预算切),每批之间刷新已有笔记标题,
 * 这样后面的批次能链到前面新建的笔记上,而不是各自为政造孤点。
 */
ipcMain.handle('autocapture:backfill', async (_e, { maxBatches = 40, includeCliSessions = true } = {}) => {
  const cfg = autoCapture.getConfig();
  const obsCfg = obsidian.getConfig();
  if (obsCfg.transport === 'file' && !obsCfg.vaultPath) throw new Error('未配置 Obsidian vault 路径');

  // 应用内对话 + 本机/远程所有项目的 CLI 会话(后两者往往是经验的大头)
  send('autocapture:progress', { text: '正在收集各来源(含远程主机上的项目会话)…' });
  const { convos, local, remoteFiles } = await gatherAllSources({ includeCliSessions });
  const all = [...convos, ...local.map((s) => ({ title: s.title, content: s.content }))];
  if (!all.length && !remoteFiles.length) return { count: 0, created: 0, merged: 0, note: '没有可沉淀的历史对话' };

  // 按字符预算分批,避免单次提示词过长被截断
  const batches = [];
  let cur = [], curLen = 0;
  for (const c of all) {
    if (curLen + c.content.length > BACKFILL_CHARS_PER_BATCH && cur.length) { batches.push(cur); cur = []; curLen = 0; }
    cur.push(c); curLen += c.content.length;
  }
  if (cur.length) batches.push(cur);

  // 远程会话:按传输预算分页,每页在提炼时才拉内容 —— 这样「全部历史」才真的是全部,
  // 又不至于一次把几十上百 MB 灌进内存或压垮 SSH
  const remotePages = cliSessions.pageRemoteFiles(remoteFiles);
  const todo = [...batches, ...remotePages.map((page) => ({ __remotePage: page }))].slice(0, maxBatches);

  const s = getSession(cfg.hostId || 'local');
  await s.installer.ensureGrokConfig(loadSettings().grokModels || []).catch(() => {});

  // 自动挑一个真的能用的引擎:配置里那个不行就换,而不是直接失败
  send('autocapture:progress', { text: '正在挑选可用的抽取引擎…' });
  const picked = await pickWorkingExtractor(s, { preferred: cfg.agent, model: cfg.model });
  if (!picked.agent) {
    throw new Error(
      `没有可用的抽取引擎(主机 ${cfg.hostId || 'local'}):\n  ${picked.tried.join('\n  ')}\n`
      + '→ 到「环境配置」页安装并登录任一引擎(codex 最省事),或在设置里换一台已配好的主机。'
    );
  }
  const agent = picked.agent;
  if (agent !== cfg.agent) {
    send('autocapture:progress', { text: `配置的 ${cfg.agent} 不可用,已自动改用 ${agent}` });
  }
  const useModel = picked.model || '';

  let created = 0, merged = 0, total = 0;
  const errors = [];
  for (let i = 0; i < todo.length; i += 1) {
    send('autocapture:progress', { text: `正在提炼第 ${i + 1}/${todo.length} 批(共 ${all.length} 段对话)…`, done: i, total: todo.length });
    const session = new AgentSession(s.ssh, s.proxy, { agent, cwd: '', model: useModel, permissionMode: 'workspace' });
    let collected = '';
    session.on('message', (m) => {
      if (m.kind === 'text' || m.kind === 'result') collected += `\n${m.text || ''}`;
      else if (m.kind === 'text_delta') collected += m.text || '';
    });
    try {
      // 远程页:此时才去拉这一页的内容
      let conversations = todo[i];
      if (conversations.__remotePage) {
        const page = conversations.__remotePage;
        const hostId = page[0]?.hostId;
        const hs = sessions.get(hostId);
        if (!hs?.ssh) { errors.push(`第 ${i + 1} 批:主机 ${hostId} 已断开,跳过`); continue; }
        send('autocapture:progress', { text: `正在从 ${hostId} 拉取第 ${i + 1}/${todo.length} 批会话(${page.length} 个文件)…` });
        // eslint-disable-next-line no-await-in-loop
        const fetched = await cliSessions.fetchRemoteSessionPage(
          (cmd) => hs.ssh.exec(cmd), page, { hostLabel: hostId }
        );
        if (!fetched.length) { errors.push(`第 ${i + 1} 批:${hostId} 这页没有有效会话`); continue; }
        conversations = fetched.map((f) => ({ title: f.title, content: f.content }));
      }
      // eslint-disable-next-line no-await-in-loop
      await session.send(obsidianNotes.buildDailyExtractPrompt({
        date: '历史回溯',
        conversations,
        existingTitles: obsidian.listExistingTitles()   // 每批都刷新,后批才能链到前批
      }));
      const parsed = obsidianNotes.parseNotesJson(collected);
      if (!parsed) {
        // 记下原因而不是静默跳过 —— 否则用户只看到「沉淀 0 篇」无从下手
        errors.push(`第 ${i + 1} 批:模型没返回可解析的 JSON${collected.trim() ? `(输出前 120 字:${collected.trim().slice(0, 120)})` : '(输出为空,多半是模型调用失败)'}`);
        continue;
      }
      const { notes, moc } = obsidianNotes.normalizeNotes(parsed);
      if (!notes.length) { errors.push(`第 ${i + 1} 批:模型判断无可沉淀内容`); continue; }
      // eslint-disable-next-line no-await-in-loop
      const r = await obsidian.saveNotesMerging({ notes, mocName: moc, source: `历史回溯 · ${agent}` });
      created += r.created; merged += r.merged; total += notes.length;
    } catch (e) {
      const reason = String(e?.message || e).slice(0, 160);
      errors.push(`第 ${i + 1} 批失败:${reason}`);
      send('autocapture:progress', { text: `第 ${i + 1} 批失败(已跳过):${reason}` });
    }
  }
  send('autocapture:progress', { text: '', done: todo.length, total: todo.length });
  return { count: total, created, merged, batches: todo.length, conversations: all.length, errors };
});

/**
 * 自动挑一个「真的能用」的抽取引擎。
 * 手工配引擎太容易配错(装了但没登录、装了但架构不符、有额度的模型没选上),
 * 与其让用户猜,不如逐个实测:先看 CLI 在不在,再实调一次确认能出结果。
 */
async function pickWorkingExtractor(s, { preferred, model } = {}) {
  const env = await s.installer.detect().catch(() => ({}));
  const installed = { codex: env.codex, claude: env.claude, deepseek: env.claude, grok: env.grok };
  // 优先用用户指定的;其余按「配置成本低 → 高」排序
  const order = [...new Set([preferred, 'codex', 'claude', 'grok', 'deepseek'].filter(Boolean))];
  const tried = [];
  for (const agent of order) {
    if (!installed[agent]) { tried.push(`${agent}:未安装`); continue; }
    // 指定了模型只对指定引擎生效,自动挑选时一律用该引擎的默认模型
    // eslint-disable-next-line no-await-in-loop
    const pre = await preflightExtractor(s, agent, agent === preferred ? model : '');
    if (pre.ok) return { agent, model: agent === preferred ? model : '', tried };
    tried.push(`${agent}:${String(pre.reason || '').split('\n')[0].slice(0, 80)}`);
  }
  return { agent: null, tried };
}

/** 抽取引擎连通性预检:实际调一次极小的请求,确认模型真能出结果 */
async function preflightExtractor(s, agent, model) {
  try {
    const env = await s.installer.detect();
    const cli = { codex: env.codex, claude: env.claude, deepseek: env.claude, grok: env.grok }[agent];
    if (!cli) {
      return { ok: false, reason: `目标主机上没有 ${agent === 'deepseek' ? 'claude' : agent} CLI,请到「环境配置」页安装,或在设置里换一个已装好的引擎` };
    }
    const probe = new AgentSession(s.ssh, s.proxy, { agent, cwd: '', model: model || '', permissionMode: 'workspace' });
    let out = '';
    probe.on('message', (m) => {
      if (m.kind === 'text' || m.kind === 'result') out += m.text || '';
      else if (m.kind === 'text_delta') out += m.text || '';
      else if (m.kind === 'error' || m.kind === 'stderr') out += `\n[err] ${m.text || ''}`;
    });
    await probe.send('只回复两个字:可用');
    if (!out.trim()) return { ok: false, reason: '模型没有任何输出(可能是 API Key 未配置、额度用尽或网络不通)' };
    if (/error|not found|unauthorized|credit|quota|api key|not signed in/i.test(out)) {
      let hint = '';
      // 常见且可一键解决的情况,直接给出处置建议,别让用户自己翻文档
      if (/not signed in|XAI_API_KEY|grok login/i.test(out)) {
        hint = '\n→ grok CLI 未登录。最快的办法:到「设置 → Obsidian 知识库 → 每日自动沉淀」把「抽取引擎」改成已经能用的引擎(如 codex);'
          + '或在「环境配置 → 国产模型端点配置」添加你的中转站端点并写入对应 API Key。';
      } else if (/credit|quota|额度/i.test(out)) {
        hint = '\n→ 该模型额度不足,换一个仍有额度的模型或引擎。';
      } else if (/api key|unauthorized/i.test(out)) {
        hint = '\n→ API Key 未配置或无效,到「环境配置」页写入对应的 Key。';
      }
      return { ok: false, reason: out.trim().slice(0, 240) + hint };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) };
  }
}

/** 逐台诊断远程会话记录的真实情况(路径/数量/CLI 安装),不再靠猜 */
ipcMain.handle('autocapture:diagnoseRemote', async () => {
  const results = [];
  for (const [hostId, s] of sessions.entries()) {
    if (hostId === LOCAL_ID) continue;
    if (!s?.ssh || s.ssh.status !== 'connected') {
      results.push({ hostId, connected: false });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await s.ssh.exec(cliSessions.buildRemoteDiagnoseCommand());
      results.push({ hostId, connected: true, ...cliSessions.parseRemoteDiagnose(r.stdout) });
    } catch (e) {
      results.push({ hostId, connected: true, error: String(e?.message || e).slice(0, 160) });
    }
  }
  return results;
});

ipcMain.handle('autocapture:getConfig', () => autoCapture.getConfig());
ipcMain.handle('autocapture:setConfig', (_e, cfg) => autoCapture.setConfig(cfg || {}));
ipcMain.handle('autocapture:runNow', (_e, { date } = {}) =>
  autoCapture.runOnce({ force: true, date: date || autoCapture.dayKey(new Date()) }));

/* ---------------- 对话历史持久化 ---------------- */
ipcMain.handle('convos:list', () => loadConvos());
ipcMain.handle('convos:save', (_e, convos) => { saveConvos(convos); return true; });

/* ---------------- Agent 对话(按 convId 隔离) ---------------- */
ipcMain.handle('agent:start', async (_e, { hostId, convId, opts, resume }) => {
  const s = getSession(hostId);
  const existing = s.agents.get(convId);
  if (existing) existing.cancel();
  // grok 引擎:启动前确保 ~/.grok/config.toml 含国产模型受管块(预设 + 界面里配的自定义模型)
  if (opts?.agent === 'grok') {
    const custom = loadSettings().grokModels || [];
    await s.installer.ensureGrokConfig(custom).catch((e) => {
      send('agent:message', {
        hostId, convId,
        msg: { kind: 'stderr', text: `写入 ~/.grok/config.toml 失败: ${e.message}` }
      });
    });
  }
  const agent = new AgentSession(s.ssh, s.proxy, opts);
  // 恢复上次会话的 resume 状态,实现跨重启续聊
  if (resume) {
    agent.claudeSessionId = resume.claudeSessionId || null;
    agent.codexSessionId = resume.codexSessionId || null;
    agent.codexStarted = !!resume.codexStarted;
    agent.grokSessionId = resume.grokSessionId || null;
  }
  agent.on('message', (msg) => {
    // 在每轮结束时附带最新 resume 状态,供渲染层持久化
    if (msg.kind === 'done') {
      msg.claudeSessionId = agent.claudeSessionId;
      msg.codexSessionId = agent.codexSessionId;
      msg.codexStarted = agent.codexStarted;
      msg.grokSessionId = agent.grokSessionId;
      msg.agent = agent.opts.agent; // 本轮实际执行的引擎
      msg.transient = agent.transient || null; // 本轮是否被网络/代理掐断(可自动续跑)
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
      grokSessionId: agent.grokSessionId,
      agent: agent.opts.agent,
      transient: agent.transient || null
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

ipcMain.handle('fs:upload', async (_e, { hostId, localPath, remotePath, transferId }) => {
  const s = getSession(hostId);
  await s.ssh.upload(localPath, remotePath, (p) =>
    send('transfer:progress', { hostId, transferId, ...p }));
  return true;
});

ipcMain.handle('fs:download', async (_e, { hostId, remotePath, localPath, transferId }) => {
  const s = getSession(hostId);
  await s.ssh.download(remotePath, localPath, (p) =>
    send('transfer:progress', { hostId, transferId, ...p }));
  return true;
});

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
  // 允许预览会话工作目录下的图片:优先用渲染层传来的 cwd,退回活跃 agent 会话的 cwd
  const cwd = payload.cwd || session.agents?.get(payload.convId)?.opts?.cwd || '';
  return getAttachmentService(session).resolveImage({
    ...payload,
    cwd,
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
