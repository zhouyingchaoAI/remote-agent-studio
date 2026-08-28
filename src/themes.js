/**
 * 皮肤(配色主题)。
 *
 * 界面本来就是 CSS 变量驱动的,所以皮肤只是换一组变量值。但有两件事
 * 不能只凭"看着好看"来定:
 *
 *  1. **每个主题必须定义全部 token**。少一个,用到它的地方就会静默退化成
 *     透明背景或继承色 —— 这不是"稍微丑一点",而是控件直接看不见。
 *     本项目就已经栽过:--panel / --fg 被用了却从没定义过。
 *  2. **正文与背景的对比度必须达标**。深色主题很容易调出好看但读不清的
 *     配色,而这是个天天要读日志和 diff 的工具。所以有一条测试卡住
 *     WCAG AA(正文 4.5:1、次要文字 3:1)。
 */

/** 所有主题都必须提供这些 token —— 缺一个就是控件消失 */
export const REQUIRED_TOKENS = [
  'bg', 'bg2', 'bg3', 'panel', 'border',
  'text', 'fg', 'muted',
  'accent', 'accent2', 'green', 'ok', 'red', 'yellow'
];

/**
 * 派生别名:--fg 就是 --text,--panel 就是 --bg2,--ok 就是 --green。
 * 历史上这三个被组件用了却没人定义,补齐的同时保留别名,
 * 免得再去改一堆已经写好的样式。
 */
function withAliases(p) {
  return { ...p, fg: p.fg || p.text, panel: p.panel || p.bg2, ok: p.ok || p.green };
}

export const THEMES = [
  {
    id: 'dark',
    name: '深邃',
    desc: '默认深色,长时间看代码不刺眼',
    colors: withAliases({
      bg: '#0f1117', bg2: '#161a23', bg3: '#1e2430', border: '#2a3140',
      text: '#e4e8f1', muted: '#8b93a7',
      accent: '#4f8cff', accent2: '#7c5cff',
      green: '#3ecf8e', red: '#ff5c5c', yellow: '#f0b429'
    })
  },
  {
    id: 'midnight',
    name: '午夜',
    desc: '更沉的蓝黑,暗环境下用',
    colors: withAliases({
      bg: '#080b14', bg2: '#0d1220', bg3: '#141b2d', border: '#1f2940',
      text: '#dfe6f5', muted: '#7e8ba8',
      accent: '#5b9dff', accent2: '#9d7bff',
      green: '#3ddc97', red: '#ff6b6b', yellow: '#ffc857'
    })
  },
  {
    id: 'graphite',
    name: '石墨',
    desc: '中性灰,不带色偏,看截图和配色最准',
    colors: withAliases({
      bg: '#141414', bg2: '#1c1c1c', bg3: '#262626', border: '#383838',
      text: '#e8e8e8', muted: '#9a9a9a',
      accent: '#7aa2f7', accent2: '#bb9af7',
      green: '#41c98a', red: '#f7768e', yellow: '#e0af68'
    })
  },
  {
    id: 'forest',
    name: '森野',
    desc: '墨绿底色,绿色强调',
    colors: withAliases({
      bg: '#0d1512', bg2: '#121d19', bg3: '#1a2823', border: '#243830',
      text: '#e0ece6', muted: '#87a096',
      accent: '#4ec9a0', accent2: '#6fd3b8',
      green: '#5bd6a4', red: '#ff7a7a', yellow: '#e8c56b'
    })
  },
  {
    id: 'sunset',
    name: '落日',
    desc: '暖褐底色,晚上看着不冷',
    colors: withAliases({
      bg: '#17110f', bg2: '#201815', bg3: '#2c211c', border: '#3d2e27',
      text: '#f0e6e0', muted: '#a89388',
      accent: '#ff9e64', accent2: '#f7768e',
      green: '#7bd88f', red: '#ff6e6e', yellow: '#ffc978'
    })
  },
  {
    id: 'light',
    name: '浅色',
    desc: '白底,白天或投屏时用',
    colors: withAliases({
      bg: '#f6f7f9', bg2: '#ffffff', bg3: '#eceef2', border: '#d6dae2',
      text: '#1c2330', muted: '#5b6577',
      accent: '#2f6fed', accent2: '#6a4bff',
      green: '#127a52', red: '#c62828', yellow: '#8a5b00'
    })
  },
  {
    id: 'contrast',
    name: '高对比',
    desc: '纯黑底 + 高亮文字,强光下或视力吃力时用',
    colors: withAliases({
      bg: '#000000', bg2: '#0d0d0d', bg3: '#1a1a1a', border: '#4d4d4d',
      text: '#ffffff', muted: '#c4c4c4',
      accent: '#66b3ff', accent2: '#d9a6ff',
      green: '#5cff9d', red: '#ff8a8a', yellow: '#ffd633'
    })
  }
];

export const DEFAULT_THEME = 'dark';

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === DEFAULT_THEME);
}

/* ------------------------------------------------------------ 应用 */

/**
 * 把一套配色写到根元素上。
 *
 * 用行内 CSS 变量而不是切 class:这样「自定义强调色」可以只覆盖一个 token,
 * 不必为每种组合预生成一份 CSS。
 *
 * data-theme 仍然照设 —— 已有样式和 xterm 主题按它取值,去掉会破坏现有逻辑。
 */
export function applyTheme(id, { accent = '' } = {}, root = null) {
  const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!el) return null;
  const theme = getTheme(id);
  const colors = { ...theme.colors };
  if (accent && isHexColor(accent)) {
    colors.accent = accent;
    // 别名要跟着走,否则强调色只改一半,界面会出现两种蓝
    colors.fg = colors.fg || colors.text;
  }
  for (const key of REQUIRED_TOKENS) {
    if (colors[key]) el.style.setProperty(`--${key}`, colors[key]);
  }
  el.setAttribute('data-theme', theme.id);
  return theme;
}

export function isHexColor(v) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '').trim());
}

/* ------------------------------------------------------------ 对比度 */

function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 相对亮度(WCAG 定义) */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * 对比度。这不是锦上添花的检查 ——
 * 深色主题很容易调出好看但读不清的配色,而这是个天天读日志和 diff 的工具。
 */
export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
