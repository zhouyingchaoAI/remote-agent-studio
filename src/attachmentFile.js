/**
 * 把 File 实例收敛成普通对象。
 *
 * ── 一个很隐蔽的坑 ──
 *
 * `File` 的 `name` / `size` / `type` 都是**原型上的 getter**,不是自有属性。
 * 所以 `{ ...file, thumb }` 展开出来只剩 Electron 挂上去的 `path`,
 * `name` 和 `size` 全没了 —— 而且**不报任何错**,直到主进程那边
 * `validateFiles` 抛一句「附件信息不完整」,看不出跟展开有什么关系。
 *
 * 触发路径正是缩略图:图片附件加进来后异步生成缩略图,回来时做
 * `{ ...it, thumb }` 把 File 拍平成了 `{ path, thumb }`。
 * 消息**排队**时这个坑必现 —— 排队意味着要等上一轮跑完,
 * 缩略图一定来得及落地,把附件对象换成残缺的那个。
 *
 * 修法不是"展开的时候小心点",而是**在入口就不再持有 File 实例**:
 * 一进来就抄成普通对象,后面怎么展开都不会掉东西,
 * 顺便也能安全地走 IPC(File 走结构化克隆同样会丢 path)。
 */

/** 需要带到主进程的字段。少一个都会让 validateFiles 判定"信息不完整"。 */
export const ATTACHMENT_FIELDS = ['path', 'name', 'size', 'type'];

/**
 * @param file File 实例,或已经是普通对象(重复调用是安全的)
 * @returns {{path,name,size,type}} 普通对象
 */
export function toAttachment(file) {
  if (!file) return null;
  /* 逐个字段显式读取。**不能用展开** —— 那正是这个 bug 的成因。 */
  const out = {
    path: file.path || '',
    name: file.name || '',
    size: Number.isFinite(file.size) ? file.size : NaN,
    type: file.type || ''
  };
  // 已经带了缩略图的(重复归一化)要保留,否则预览会闪一下没了
  if (file.thumb) out.thumb = file.thumb;
  return out;
}

/** 归一化一批,顺手滤掉拿不到路径的(拖进来的是文件夹时会这样) */
export function toAttachments(files) {
  return Array.from(files || []).map(toAttachment).filter((f) => f && f.path);
}

/**
 * 附件信息是不是完整到能发出去。
 *
 * 和主进程 validateFiles 同一套判据 —— 在渲染端先查一遍,
 * 是为了能在**发送前**就把问题说清楚,而不是等上传时抛一句
 * 「附件信息不完整」,那时候用户既不知道是哪个文件,也不知道为什么。
 */
export function attachmentProblem(file) {
  if (!file) return '附件为空';
  if (!file.path) return '拿不到文件路径(拖进来的可能是文件夹)';
  if (!file.name) return '拿不到文件名';
  if (!Number.isFinite(file.size)) return '拿不到文件大小';
  return '';
}
