/**
 * 按扩展名给出类型标签与配色。
 * 图标用首字母而不是 emoji:emoji 在不同系统上字形差异大,
 * 而且没法表达「这是 Word 还是 Excel」这种关键区别。
 */
export function fileKind(name = '') {
  const ext = (String(name).match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
  const T = {
    docx: ['文档', '#2b5797', 'W'], doc: ['文档', '#2b5797', 'W'],
    xlsx: ['表格', '#1e7145', 'X'], xls: ['表格', '#1e7145', 'X'], csv: ['表格', '#1e7145', 'X'],
    pptx: ['演示', '#c8502a', 'P'], ppt: ['演示', '#c8502a', 'P'],
    pdf: ['文档', '#b3312c', 'P'],
    zip: ['压缩包', '#6b6b6b', 'Z'], tar: ['压缩包', '#6b6b6b', 'Z'], gz: ['压缩包', '#6b6b6b', 'Z'],
    md: ['文档', '#4a5568', 'M'], txt: ['文本', '#4a5568', 'T'],
    json: ['数据', '#8a6d1f', 'J'], yaml: ['数据', '#8a6d1f', 'Y'], yml: ['数据', '#8a6d1f', 'Y']
  };
  const [label, color, letter] = T[ext] || ['文件', '#4a5568', ext ? ext[0].toUpperCase() : '?'];
  return { ext: ext.toUpperCase(), label, color, letter };
}
