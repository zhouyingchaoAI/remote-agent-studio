// ESLint 扁平配置(ESLint 9+)。仅用内置规则,避免额外插件的安装成本。
const globals = {
  browser: {
    window: 'readonly', document: 'readonly', navigator: 'readonly',
    atob: 'readonly', btoa: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
    requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
    ResizeObserver: 'readonly', localStorage: 'readonly', Uint8Array: 'readonly',
    prompt: 'readonly', confirm: 'readonly', alert: 'readonly',
    navigator: 'readonly', MediaRecorder: 'readonly', Blob: 'readonly', FormData: 'readonly',
    getComputedStyle: 'readonly', devicePixelRatio: 'readonly'
  },
  node: {
    require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly',
    Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
    setInterval: 'readonly', clearInterval: 'readonly', global: 'readonly',
    setImmediate: 'readonly', queueMicrotask: 'readonly',
    // Node 18+ 全局
    fetch: 'readonly', FormData: 'readonly', Blob: 'readonly', AbortController: 'readonly'
  }
};

const commonRules = {
  'no-unused-vars': ['warn', {
    args: 'none',
    caughtErrors: 'none',
    ignoreRestSiblings: true,
    varsIgnorePattern: '^_|^React$'
  }],
  'no-undef': 'error',
  'no-var': 'error',
  'prefer-const': 'warn',
  eqeqeq: ['warn', 'smart'],
  'no-console': 'off'
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'release/**'] },
  // react-hooks/* 规则由可选插件提供,未安装时保留 disable 指令但不报"未使用"
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['electron/**/*.js', 'scripts/**/*.js', 'test/**/*.js', '*.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node },
    rules: commonRules
  },
  {
    files: ['vite.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
    rules: commonRules
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser }
    },
    rules: {
      ...commonRules,
      // 无 eslint-plugin-react 时,no-unused-vars 无法识别 JSX 中引用的组件 -> 关闭以免误报
      'no-unused-vars': 'off'
    }
  }
];
