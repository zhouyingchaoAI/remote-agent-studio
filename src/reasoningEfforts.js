/**
 * codex 推理强度的可选项(与 electron/ssh/codexOptions.js 保持一致)。
 * 渲染进程拿不到主进程模块,所以这里单独列一份;两边的取值由单测锁死,
 * 不一致会直接失败 —— 手抄两份最怕的就是悄悄漂移。
 */
export const REASONING_EFFORTS = [
  { value: '', label: '默认' },
  { value: 'minimal', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' }
];
