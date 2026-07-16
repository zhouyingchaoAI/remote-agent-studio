export const dictionaries = {
  'zh-CN': {
    settings: '设置', language: '语言', chinese: '简体中文', english: 'English',
    theme: '主题', dark: '深色', light: '浅色', terminalFontSize: '终端字号',
    defaultPermission: '新对话默认权限', workspace: '工作区(受限,推荐)', plan: '计划模式(只读)',
    system: '系统权限(放开)', addHost: '添加主机', edit: '编辑', delete: '删除',
    expandFiles: '展开文件', connecting: '连接中...', disconnected: '未连接',
    homeDirectory: '家目录', projectDirectory: '项目目录', empty: '(空)',
    chat: '对话', files: '文件', terminal: '终端', tasks: '任务', transfers: '传输', setup: '环境配置',
    addSshHost: '在左侧添加一台 SSH 主机，即可远程使用 Codex / Claude Code',
    noTasks: '尚无任务', taskHelp: '从对话页创建任务后，在这里验收交付。', usageOverview: '用量概览',
    openChat: '打开对话', stopTakeover: '停止并接管', changes: '变更', artifacts: '产物', dangerousOps: '危险操作',
    changeEvidence: '变更证据', securityAudit: '安全审计', reviewNote: '验收备注（可选）', accept: '验收通过', requestChanges: '要求修改', noTransfers: '暂无传输任务', transferHelp: '上传和下载任务会持续显示在这里。',
    status_draft: '草稿', status_queued: '排队中', status_running: '执行中', status_needs_input: '等待输入', status_needs_approval: '等待审批', status_review_ready: '待验收', status_accepted: '已验收', status_changes_requested: '需修改', status_failed: '失败', status_archived: '已归档', risk_read: '只读', risk_workspace_write: '项目写入', risk_external_side_effect: '外部影响', risk_system: '系统级', upload: '上传', download: '下载', retry: '重试', cancel: '取消', completed: '完成', cancelled: '已取消', terminalTab: '终端', closeTab: '关闭标签', newTerminalTab: '新建终端标签', terminalReady: '远程终端（已自动加载代理与 codex/claude 路径）', searchTerminal: '搜索终端输出', previousMatch: '上一个匹配', nextMatch: '下一个匹配', closeSearch: '关闭搜索', search: '搜索', reconnectTerminal: '重连终端', copy: '复制', paste: '粘贴', terminalClosed: '会话已关闭，可点右上角「重连终端」', reconnectingTerminal: '正在重连终端并加载最新代理/环境...', connectHostFirst: '请先连接主机', localEnvironment: '本机环境', remoteEnvironment: '远程环境', refresh: '刷新', operatingSystem: '系统', notInstalled: '未安装', upgradeCodex: '升级 Codex 到最新', installCodex: '一键安装 Codex', upgradeClaude: '升级 Claude Code 到最新', installClaude: '一键安装 Claude Code', localInstallHint: '本机通过 npm 安装/升级到最新版；若由 Homebrew 安装，请在终端运行 brew upgrade。', remoteInstallHint: '缺少 Node.js 时会自动通过 nvm 安装（免 root）；安装走下方代理配置。', networkProxy: '网络代理', directProxy: '局域网代理直连（默认）', directProxyHint: '远程直接访问本机/局域网代理', autoLanIp: '自动使用本机当前 IP（推荐，IP 变化后每次连接自动重新解析）', proxyPort: '代理端口', resolving: '检测中...', currentResolution: '当前解析', fixedProxyAddress: '代理地址（固定）', proxyExplanation: '远程会 export HTTP_PROXY/HTTPS_PROXY 指向此地址。需确保本机 Clash 已开启「允许局域网连接」，且远程与本机网络可达。', reverseTunnel: 'SSH 反向隧道', reverseTunnelHint: '远程借道本机代理上网（远程连不上本机 IP 时用）', localProxyAddress: '本机侧代理地址', localProxyPort: '本机侧代理端口', remoteListenPort: '远程监听端口', noProxy: '不使用代理 / 清除配置', applyProxy: '应用代理配置并测试', localCodexAuth: '本机 Codex 认证', syncCodexAuth: '下发 Codex 认证到远程', syncClaudeAuth: '下发 Claude 认证', authSyncHint: '把本机已登录的 ~/.codex/auth.json（含 config.toml）复制到远程同路径，远程免登录直接使用。下发后会自动测试远程可用性。', testRemoteCodex: '测试远程 Codex', testRemoteClaude: '测试远程 Claude', optionalApiKey: 'API Key（可选）', apiKeyHint: '也可以在「终端」页运行 codex login / claude 交互登录。', saveToRemote: '写入远程', logs: '日志', exportDiagnostics: '导出诊断', diagnosticsTitle: '导出应用诊断信息（版本/平台/最近日志）', clear: '清空', noLogs: '（暂无日志）', apiKeyRequired: '请输入 API Key', detectionFailed: '检测失败', diagnosticsExported: '诊断信息已导出', localCli: '本机 CLI', notFoundInPath: '未在 PATH 找到', authFile: '认证文件', exists: '存在', authStatus: '认证状态', valid: '有效', invalidAuth: '无效或未登录，请先在本机运行 codex 登录', testLocalCodex: '测试本机 Codex 配置'
  },
  en: {
    settings: 'Settings', language: 'Language', chinese: 'Simplified Chinese', english: 'English',
    theme: 'Theme', dark: 'Dark', light: 'Light', terminalFontSize: 'Terminal font size',
    defaultPermission: 'Default permission for new chats', workspace: 'Workspace (restricted, recommended)', plan: 'Plan mode (read-only)',
    system: 'System mode (unrestricted)', addHost: 'Add host', edit: 'Edit', delete: 'Delete',
    expandFiles: 'Expand files', connecting: 'Connecting...', disconnected: 'Disconnected',
    homeDirectory: 'Home directory', projectDirectory: 'Project directory', empty: '(empty)',
    chat: 'Chat', files: 'Files', terminal: 'Terminal', tasks: 'Tasks', transfers: 'Transfers', setup: 'Environment',
    addSshHost: 'Add an SSH host on the left to use Codex / Claude Code remotely',
    noTasks: 'No tasks yet', taskHelp: 'Create a task from a chat, then review its delivery here.', usageOverview: 'Usage overview',
    openChat: 'Open chat', stopTakeover: 'Stop and take over', changes: 'Changes', artifacts: 'Artifacts', dangerousOps: 'Dangerous operations',
    changeEvidence: 'Change evidence', securityAudit: 'Security audit', reviewNote: 'Review note (optional)', accept: 'Accept', requestChanges: 'Request changes', noTransfers: 'No transfer tasks yet', transferHelp: 'Uploads and downloads remain visible here.',
    status_draft: 'Draft', status_queued: 'Queued', status_running: 'Running', status_needs_input: 'Needs input', status_needs_approval: 'Needs approval', status_review_ready: 'Ready for review', status_accepted: 'Accepted', status_changes_requested: 'Changes requested', status_failed: 'Failed', status_archived: 'Archived', risk_read: 'Read-only', risk_workspace_write: 'Workspace write', risk_external_side_effect: 'External side effect', risk_system: 'System', upload: 'Upload', download: 'Download', retry: 'Retry', cancel: 'Cancel', completed: 'Completed', cancelled: 'Cancelled', terminalTab: 'Terminal', closeTab: 'Close tab', newTerminalTab: 'New terminal tab', terminalReady: 'Remote terminal (proxy and Codex/Claude paths loaded)', searchTerminal: 'Search terminal output', previousMatch: 'Previous match', nextMatch: 'Next match', closeSearch: 'Close search', search: 'Search', reconnectTerminal: 'Reconnect terminal', copy: 'Copy', paste: 'Paste', terminalClosed: 'Session closed; use Reconnect terminal in the upper right.', reconnectingTerminal: 'Reconnecting terminal and loading the latest proxy/environment...', connectHostFirst: 'Connect to the host first', localEnvironment: 'Local environment', remoteEnvironment: 'Remote environment', refresh: 'Refresh', operatingSystem: 'System', notInstalled: 'Not installed', upgradeCodex: 'Upgrade Codex', installCodex: 'Install Codex', upgradeClaude: 'Upgrade Claude Code', installClaude: 'Install Claude Code', localInstallHint: 'Install or upgrade locally with npm. For Homebrew installs, run brew upgrade in Terminal.', remoteInstallHint: 'If Node.js is missing, it is installed with nvm without root access. Installation uses the proxy settings below.', networkProxy: 'Network proxy', directProxy: 'Direct LAN proxy (default)', directProxyHint: 'The remote host accesses your local/LAN proxy directly', autoLanIp: 'Use the current local IP automatically (recommended; resolves again on every connection)', proxyPort: 'Proxy port', resolving: 'Resolving...', currentResolution: 'Resolved', fixedProxyAddress: 'Fixed proxy address', proxyExplanation: 'The remote host exports HTTP_PROXY/HTTPS_PROXY to this address. Enable LAN access in Clash and ensure the remote host can reach your local network.', reverseTunnel: 'SSH reverse tunnel', reverseTunnelHint: 'The remote host uses your local proxy through SSH (when it cannot reach your local IP)', localProxyAddress: 'Local proxy address', localProxyPort: 'Local proxy port', remoteListenPort: 'Remote listen port', noProxy: 'Do not use a proxy / clear configuration', applyProxy: 'Apply proxy configuration and test', localCodexAuth: 'Local Codex authentication', syncCodexAuth: 'Send Codex authentication to remote', syncClaudeAuth: 'Send Claude authentication to remote', authSyncHint: 'Copies local ~/.codex/auth.json (including config.toml) to the same remote path. The remote host can then use it without signing in and is tested automatically.', testRemoteCodex: 'Test remote Codex', testRemoteClaude: 'Test remote Claude', optionalApiKey: 'API Key (optional)', apiKeyHint: 'You can also run codex login / claude interactively in Terminal.', saveToRemote: 'Save to remote', logs: 'Logs', exportDiagnostics: 'Export diagnostics', diagnosticsTitle: 'Export app diagnostics (version/platform/recent logs)', clear: 'Clear', noLogs: '(no logs)', apiKeyRequired: 'Enter an API key', detectionFailed: 'Detection failed', diagnosticsExported: 'Diagnostics exported', localCli: 'Local CLI', notFoundInPath: 'Not found in PATH', authFile: 'Authentication file', exists: 'Exists', authStatus: 'Authentication status', valid: 'valid', invalidAuth: 'Invalid or signed out; run codex login locally first', testLocalCodex: 'Test local Codex setup'
  }
};

Object.assign(dictionaries['zh-CN'], {
  conversationHistory: '对话记录', newConversation: '新建对话',
  searchConversations: '搜索标题 / 目录 / 内容...', noMatchingConversations: '没有匹配的对话',
  noConversations: '还没有对话。点「新建对话」选择项目目录和 agent 开始。',
  rename: '重命名', recent: '最近', messages: '条消息'
});
Object.assign(dictionaries.en, {
  conversationHistory: 'Conversation history', newConversation: 'New conversation',
  searchConversations: 'Search title / directory / content...', noMatchingConversations: 'No matching conversations',
  noConversations: 'No conversations yet. Create one, select a project directory and agent to begin.',
  rename: 'Rename', recent: 'Recent', messages: 'messages'
});

export function normalizeLanguage(value) {
  return value === 'en' ? 'en' : 'zh-CN';
}

export function translate(language, key) {
  return dictionaries[normalizeLanguage(language)]?.[key] || key;
}
