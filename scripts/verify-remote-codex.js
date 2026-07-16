const { app, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SSHManager } = require('../electron/ssh/SSHManager');
const { ProxyService } = require('../electron/ssh/ProxyService');
const { Installer } = require('../electron/ssh/Installer');

app.setName('remote-agent-studio');
app.setPath('userData', path.join(process.env.APPDATA, 'remote-agent-studio'));

const targetHost = process.argv[2] || '192.168.1.111';
const skipAuth = process.argv.includes('--skip-auth');
const inspectOnly = process.argv.includes('--inspect');
const compatOnly = process.argv.includes('--compat-only');
const preserveParts = process.argv.includes('--preserve-parts');
const logPath = path.join(__dirname, inspectOnly ? 'verify-remote-codex-inspect.log' : 'verify-remote-codex.log');

fs.writeFileSync(logPath, '');

function writeLog(text) {
  const line = String(text).endsWith('\n') ? String(text) : `${text}\n`;
  process.stdout.write(line);
  fs.appendFileSync(logPath, line);
}

function decrypt(value) {
  if (!value) return '';
  if (value.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  }
  if (value.startsWith('raw:')) {
    return Buffer.from(value.slice(4), 'base64').toString();
  }
  return value;
}

function remoteQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function syncCodexAuth(ssh, log) {
  const authFiles = [
    { name: 'auth.json', required: true, mode: '600' },
    { name: 'config.toml', required: false, mode: '600' }
  ];
  const homeResult = await ssh.exec('printf %s "$HOME"');
  const remoteHome = homeResult.stdout.trim();
  if (!remoteHome) throw new Error('Unable to resolve the remote HOME directory');

  await ssh.exec(`mkdir -p ${remoteQuote(`${remoteHome}/.codex`)} && chmod 700 ${remoteQuote(`${remoteHome}/.codex`)}`);
  for (const file of authFiles) {
    const localPath = path.join(os.homedir(), '.codex', file.name);
    if (!fs.existsSync(localPath)) {
      if (file.required) throw new Error(`Missing local Codex authentication file: ${localPath}`);
      continue;
    }
    const remotePath = `${remoteHome}/.codex/${file.name}`;
    await ssh.upload(localPath, remotePath);
    await ssh.exec(`chmod ${file.mode} ${remoteQuote(remotePath)}`);
    log(`Synced ~/.codex/${file.name}`);
  }
}

async function main() {
  const hostsPath = path.join(process.env.APPDATA, 'remote-agent-studio', 'hosts.json');
  const hosts = JSON.parse(fs.readFileSync(hostsPath, 'utf8'));
  const saved = hosts.find((host) => host.host === targetHost);
  if (!saved) throw new Error(`Host ${targetHost} is not saved in Remote Agent Studio`);

  const host = {
    ...saved,
    password: decrypt(saved.password),
    passphrase: decrypt(saved.passphrase)
  };
  const ssh = new SSHManager(host);
  const proxy = new ProxyService(ssh);
  const installer = new Installer(ssh, proxy);
  const log = writeLog;

  try {
    log(`[verify] Connecting to ${host.username}@${host.host}:${host.port || 22}`);
    await ssh.connect();
    log('[verify] SSH connected');
    if (inspectOnly) {
      const inspection = await ssh.exec(
        `ps -ef | grep -E 'install-node|unofficial-builds|remote-agent-node|codex/install|codex-package|curl' | grep -v grep; ` +
        `printf '\\n-- paths --\\n'; ` +
        `ls -ld "$HOME/.remote-agent-node" "$HOME/.remote-agent-install-node.sh" 2>&1; ` +
        `find /tmp "$HOME" -maxdepth 4 -type f \\( -name '*glibc-217*.tar.*' -o -name '*codex*.tar.*' -o -name 'part.[0-7]' \\) -exec ls -lh {} \\; 2>/dev/null; ` +
        `printf '\\n-- direct connectivity --\\n'; ` +
        `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY ` +
        `curl -sSIL --max-time 10 https://unofficial-builds.nodejs.org/download/release/v22.23.1/node-v22.23.1-linux-x64-glibc-217.tar.xz | tail -5; ` +
        `printf '\\n-- direct GitHub --\\n'; ` +
        `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY ` +
        `curl -sSIL --max-time 10 https://github.com/openai/codex/releases/download/rust-v0.144.4/codex-package-x86_64-unknown-linux-musl.tar.gz | tail -5; ` +
        `printf '\\n-- codex --\\n'; ` +
        `export PATH="$HOME/.local/bin:$PATH"; command -v codex || true; codex --version 2>&1 || true; ` +
        `printf '\\n-- installer checksum logic --\\n'; ` +
        `sed -n '320,346p;940,1015p' "$HOME/.remote-agent-codex-install.sh" 2>/dev/null`
      );
      log(inspection.stdout || inspection.stderr || '[verify] No matching remote process');
      return;
    }
    if (preserveParts) {
      const preserved = await ssh.exec(
        `source_dir="$(find /tmp -maxdepth 2 -type f -name part.0 -printf '%h\\n' 2>/dev/null | tail -1)"; ` +
        `[ -n "$source_dir" ] || { echo "No Codex range cache found"; exit 1; }; ` +
        `target_dir="$HOME/.cache/remote-agent-codex/0.144.4"; mkdir -p "$target_dir"; ` +
        `cp "$source_dir"/part.* "$target_dir"/ 2>/dev/null || true; ` +
        `ls -lh "$target_dir"/part.* 2>/dev/null`
      );
      log(preserved.stdout || preserved.stderr);
      if (preserved.code !== 0) throw new Error('Unable to preserve Codex ranges');
      return;
    }
    if (compatOnly) {
      const install = await ssh.exec(
        `pkill -f '^curl .*unofficial-builds.nodejs.org.*glibc-217' 2>/dev/null || true; ` +
        `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY; ` +
        `mkdir -p "$HOME/.remote-agent-node"; ` +
        `curl -fsSL https://unofficial-builds.nodejs.org/install-node.sh -o "$HOME/.remote-agent-install-node.sh"; ` +
        `bash "$HOME/.remote-agent-install-node.sh" --yes --line 22 --platform x64-glibc-217 --dir "$HOME/.remote-agent-node"; ` +
        `code=$?; echo "INSTALL_EXIT=$code"; exit $code`,
        { onStdout: log, onStderr: log }
      );
      if (install.code !== 0) throw new Error(`Compatibility installer exited with ${install.code}`);
      return;
    }
    await ssh.exec(
      `pkill -f '^curl .*unofficial-builds.nodejs.org.*glibc-217' 2>/dev/null || true; ` +
      `pkill -f '^curl .*github.com/openai/codex/releases' 2>/dev/null || true`
    );
    const detected = await installer.detect();
    if (detected.codex) log(`[verify] Existing ${detected.codex}`);
    else await installer.installAgent('codex', log);
    if (!skipAuth) await syncCodexAuth(ssh, log);

    const env = `${proxy.envPrefix()} export NVM_DIR="$HOME/.nvm"; ` +
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; ' +
      '[ -s "$HOME/.remote-agent-node-env.sh" ] && . "$HOME/.remote-agent-node-env.sh"; ' +
      'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; ';
    const version = await ssh.exec(`${env} codex --version`);
    log(version.stdout);
    if (version.code !== 0) throw new Error(version.stderr || 'Version verification failed');

    if (skipAuth) {
      log('[verify] Codex installation verified; authentication sync was intentionally skipped.');
      return;
    }

    const run = await ssh.exec(
      `${env} cd "$HOME" && codex exec --skip-git-repo-check --sandbox read-only ` +
      `${remoteQuote('Reply with exactly REMOTE_CODEX_OK')} </dev/null`
    );
    log(run.stdout);
    if (run.code !== 0 || !run.stdout.includes('REMOTE_CODEX_OK')) {
      throw new Error(run.stderr || 'Codex did not return REMOTE_CODEX_OK');
    }
    log('[verify] REMOTE_CODEX_OK');
  } finally {
    ssh.disconnect();
  }
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    writeLog(`[verify] FAILED: ${error.stack || error.message}`);
    app.exit(1);
  });
