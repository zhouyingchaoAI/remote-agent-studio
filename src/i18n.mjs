export const dictionaries = {
  'zh-CN': {
    settings: '设置', language: '语言', chinese: '简体中文', english: 'English',
    theme: '主题', dark: '深色', light: '浅色', terminalFontSize: '终端字号',
    defaultPermission: '新对话默认权限', workspace: '工作区(受限,推荐)', plan: '计划模式(只读)',
    system: '系统权限(放开)', addHost: '添加主机', edit: '编辑', delete: '删除',
    expandFiles: '展开文件', connecting: '连接中...', disconnected: '未连接',
    homeDirectory: '家目录', projectDirectory: '项目目录', empty: '(空)'
  },
  en: {
    settings: 'Settings', language: 'Language', chinese: 'Simplified Chinese', english: 'English',
    theme: 'Theme', dark: 'Dark', light: 'Light', terminalFontSize: 'Terminal font size',
    defaultPermission: 'Default permission for new chats', workspace: 'Workspace (restricted, recommended)', plan: 'Plan mode (read-only)',
    system: 'System mode (unrestricted)', addHost: 'Add host', edit: 'Edit', delete: 'Delete',
    expandFiles: 'Expand files', connecting: 'Connecting...', disconnected: 'Disconnected',
    homeDirectory: 'Home directory', projectDirectory: 'Project directory', empty: '(empty)'
  }
};

export function normalizeLanguage(value) {
  return value === 'en' ? 'en' : 'zh-CN';
}

export function translate(language, key) {
  return dictionaries[normalizeLanguage(language)]?.[key] || key;
}
