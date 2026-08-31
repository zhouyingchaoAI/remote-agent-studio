/**
 * 终端行数的**实测**校准。
 *
 * ── 为什么不是再加一次内边距 ──
 *
 * "最后一行看不全"我修过一次,加了 14px 底部内边距 —— 没解决,
 * 因为那是在**猜**差多少。这次换个做法:fit() 之后**量一下真实 DOM**,
 * 只要渲染出来的高度超出容器,就减一行。
 *
 * 这么做的关键好处是:**它不依赖我对成因的判断是对的。**
 * 不管是 cell 高度是小数、每行各自取整累积出误差,还是别的什么,
 * 只要"画出来比装得下的高",这一步都会把它收回去。
 *
 * FitAddon 自己算的是 floor(可用高度 / cell 高度),看着没错;
 * 但 cell 高度常是小数(比如 17.6px),而每一行在渲染时各自取整,
 * 累计到二三十行就能多出小半行 —— 表现正是最后一行被横切一半。
 */

/** 亚像素容差:差这么点不算超出,否则会白白少掉一行 */
const EPS = 0.5;

/**
 * 算出真正装得下的行数。
 *
 * @param availableHeight 容器内容区高度(已扣掉内边距)
 * @param screenHeight    xterm 实际渲染出来的高度
 * @param rows            fit() 得出的行数
 *
 * 用**实测的每行高度**(screenHeight / rows)而不是理论 cell 高度 ——
 * 前者已经包含了取整误差,后者正是误差的来源。
 */
export function fittedRows(availableHeight, screenHeight, rows) {
  const r = Number(rows);
  const sh = Number(screenHeight);
  const ah = Number(availableHeight);
  // 任何一个量不可信就原样返回:宁可不调,也不要凭错误数据把行数改坏
  if (!(r > 0) || !(sh > 0) || !(ah > 0)) return rows;
  if (sh <= ah + EPS) return r;                 // 没超出,不动
  const rowH = sh / r;
  if (!(rowH > 0)) return r;
  // 至少留一行:窗口被拖到极小时也不能变成 0 行,那会让 xterm 抛错
  return Math.max(1, Math.min(r, Math.floor((ah + EPS) / rowH)));
}

/** 容器的内容区高度 —— clientHeight 含内边距,要扣掉 */
export function contentHeight(el, getStyle) {
  if (!el) return 0;
  const cs = (getStyle || ((x) => window.getComputedStyle(x)))(el);
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return Math.max(0, (el.clientHeight || 0) - pad);
}

/**
 * fit 一次,然后按实测结果校准。
 *
 * 调用方只管调这一个函数,别再各自写一遍 fit + 滚动 + 上报尺寸 ——
 * 两个终端组件各写一份的话,修好一个另一个还是坏的。
 */
export function fitExact(term, fit, box) {
  if (!term || !fit) return;
  try {
    fit.fit();
  } catch {
    return;   // 容器还没上屏时 fit 会抛,不该把整个组件带崩
  }
  const screen = term.element && term.element.querySelector('.xterm-screen');
  if (!screen || !box) return;
  const avail = contentHeight(box);
  const want = fittedRows(avail, screen.getBoundingClientRect().height, term.rows);
  if (want !== term.rows && want > 0) {
    try { term.resize(term.cols, want); } catch { /* 尺寸非法时保持原状 */ }
  }
}
