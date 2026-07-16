export const dictionaries = {
  'zh-CN': {
    settings: '设置', language: '语言', chinese: '简体中文', english: 'English',
    theme: '主题', dark: '深色', light: '浅色', terminalFontSize: '终端字号',
    defaultPermission: '新对话默认权限', workspace: '工作区(受限,推荐)', plan: '计划模式(只读)',
    system: '系统权限(放开)', addHost: '添加主机', edit: '编辑', delete: '删除',
    expandFiles: '展开文件', connecting: '连接中...', disconnected: '未连接',
    homeDirectory: '家目录', projectDirectory: '项目目录', empty: '(空)',
    chat: '对话', files: '文件', terminal: '终端', tasks: '任务', setup: '环境配置',
    addSshHost: '在左侧添加一台 SSH 主机，即可远程使用 Codex / Claude Code',
    noTasks: '尚无任务', taskHelp: '从对话页创建任务后，在这里验收交付。', usageOverview: '用量概览',
    openChat: '打开对话', stopTakeover: '停止并接管', changes: '变更', artifacts: '产物', dangerousOps: '危险操作',
    changeEvidence: '变更证据', securityAudit: '安全审计', reviewNote: '验收备注（可选）', accept: '验收通过', requestChanges: '要求修改',
    status_draft: '草稿', status_queued: '排队中', status_running: '执行中', status_needs_input: '等待输入', status_needs_approval: '等待审批', status_review_ready: '待验收', status_accepted: '已验收', status_changes_requested: '需修改', status_failed: '失败', status_archived: '已归档', risk_read: '只读', risk_workspace_write: '项目写入', risk_external_side_effect: '外部影响', risk_system: '系统级', upload: '上传', download: '下载', retry: '重试', cancel: '取消', completed: '完成', cancelled: '已取消'
  },
  en: {
    settings: 'Settings', language: 'Language', chinese: 'Simplified Chinese', english: 'English',
    theme: 'Theme', dark: 'Dark', light: 'Light', terminalFontSize: 'Terminal font size',
    defaultPermission: 'Default permission for new chats', workspace: 'Workspace (restricted, recommended)', plan: 'Plan mode (read-only)',
    system: 'System mode (unrestricted)', addHost: 'Add host', edit: 'Edit', delete: 'Delete',
    expandFiles: 'Expand files', connecting: 'Connecting...', disconnected: 'Disconnected',
    homeDirectory: 'Home directory', projectDirectory: 'Project directory', empty: '(empty)',
    chat: 'Chat', files: 'Files', terminal: 'Terminal', tasks: 'Tasks', setup: 'Environment',
    addSshHost: 'Add an SSH host on the left to use Codex / Claude Code remotely',
    noTasks: 'No tasks yet', taskHelp: 'Create a task from a chat, then review its delivery here.', usageOverview: 'Usage overview',
    openChat: 'Open chat', stopTakeover: 'Stop and take over', changes: 'Changes', artifacts: 'Artifacts', dangerousOps: 'Dangerous operations',
    changeEvidence: 'Change evidence', securityAudit: 'Security audit', reviewNote: 'Review note (optional)', accept: 'Accept', requestChanges: 'Request changes',
    status_draft: 'Draft', status_queued: 'Queued', status_running: 'Running', status_needs_input: 'Needs input', status_needs_approval: 'Needs approval', status_review_ready: 'Ready for review', status_accepted: 'Accepted', status_changes_requested: 'Changes requested', status_failed: 'Failed', status_archived: 'Archived', risk_read: 'Read-only', risk_workspace_write: 'Workspace write', risk_external_side_effect: 'External side effect', risk_system: 'System', upload: 'Upload', download: 'Download', retry: 'Retry', cancel: 'Cancel', completed: 'Completed', cancelled: 'Cancelled'
  }
};

export function normalizeLanguage(value) {
  return value === 'en' ? 'en' : 'zh-CN';
}

export function translate(language, key) {
  return dictionaries[normalizeLanguage(language)]?.[key] || key;
}
