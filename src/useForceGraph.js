/**
 * 轻量力导向布局(手写,零依赖)。
 * 只需要 Fruchterman-Reingold 的三种力:
 *   斥力(节点互相推开) + 引力(有边的互相拉近) + 向心力(防止子图飘走)
 * 配合逐步降温(cooling),几百个节点足够流畅,不必引入 d3。
 */

export function createSimulation(nodes, edges, { width = 800, height = 600 } = {}) {
  const N = nodes.length || 1;
  const area = width * height;
  const k = Math.sqrt(area / N) * 0.8;  // 理想间距

  // 初始位置:圆周分布比纯随机收敛更快、更少打结
  const state = nodes.map((n, i) => {
    const angle = (i / N) * Math.PI * 2;
    const r = Math.min(width, height) * 0.35 * (0.4 + 0.6 * Math.random());
    return {
      ...n,
      x: width / 2 + Math.cos(angle) * r,
      y: height / 2 + Math.sin(angle) * r,
      vx: 0, vy: 0, fixed: false
    };
  });
  const index = new Map(state.map((n) => [n.id, n]));
  const links = edges
    .map((e) => ({ source: index.get(e.source), target: index.get(e.target) }))
    .filter((l) => l.source && l.target);

  let temperature = Math.min(width, height) * 0.1;

  function step() {
    // 斥力:O(n²),节点多时用较大的截断距离控制开销
    for (let i = 0; i < state.length; i += 1) {
      const a = state[i];
      a.vx = 0; a.vy = 0;
      for (let j = 0; j < state.length; j += 1) {
        if (i === j) continue;
        const b = state[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = 0.01; }
        if (dist > k * 6) continue;                 // 太远的忽略,省算力
        const force = (k * k) / dist;
        a.vx += (dx / dist) * force;
        a.vy += (dy / dist) * force;
      }
    }
    // 引力
    for (const l of links) {
      const dx = l.source.x - l.target.x, dy = l.source.y - l.target.y;
      let dist = Math.hypot(dx, dy);
      if (dist < 0.01) dist = 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      l.source.vx -= fx; l.source.vy -= fy;
      l.target.vx += fx; l.target.vy += fy;
    }
    // 向心力 + 位移(受温度限制)
    const cx = width / 2, cy = height / 2;
    for (const n of state) {
      if (n.fixed) continue;
      n.vx += (cx - n.x) * 0.012;
      n.vy += (cy - n.y) * 0.012;
      const speed = Math.hypot(n.vx, n.vy) || 1;
      const limit = Math.min(speed, temperature);
      n.x += (n.vx / speed) * limit;
      n.y += (n.vy / speed) * limit;
      n.x = Math.max(20, Math.min(width - 20, n.x));
      n.y = Math.max(20, Math.min(height - 20, n.y));
    }
    // 降温收敛;不设下限,好让循环能真正停下来(否则会一直空转耗电)
    temperature *= 0.985;
  }

  return {
    nodes: state,
    links,
    step,
    /** 当前"能量":降到阈值以下即认为布局已收敛,可以停机省电 */
    energy() { return temperature; },
    settled() { return temperature <= 0.6; },
    reheat(t = 8) { temperature = t; },
    nodeAt(x, y, radiusOf) {
      // 后画的在上层,命中检测从后往前
      for (let i = state.length - 1; i >= 0; i -= 1) {
        const n = state[i];
        if (Math.hypot(n.x - x, n.y - y) <= radiusOf(n) + 3) return n;
      }
      return null;
    }
  };
}

/** 节点半径:按连接数增长(用 sqrt 避免大节点过分夸张) */
export function nodeRadius(node) {
  return 4 + Math.sqrt(node.degree || 0) * 2.6;
}
