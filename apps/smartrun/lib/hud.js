// HUD 数值自适应字号:等宽大字在固定像素列宽里的溢出防护。
// WXSS 白名单没有 overflow/text-overflow/white-space,长值(时长≥1小时的
// "1:01:01"、距离≥10km 的 "10.00")会直接压进相邻列 —— 唯一可用手段是
// 按字符数换更小的字号 class。纯逻辑,与 run_hud 模板的修饰 class 配套。

/**
 * 按显示文本长度返回字号修饰 class:
 *   长度 ≤ midLen           → ''(基础字号)
 *   midLen < 长度 ≤ smLen   → `${prefix}-mid`
 *   长度 > smLen            → `${prefix}-sm`
 * prefix 区分两套网格的基础字号(unified 用 'v',glasses 用 'g')。
 */
export function lenModifier(text, prefix, midLen, smLen) {
  const len = String(text ?? '').length;
  if (len <= midLen) return '';
  if (len <= smLen) return `${prefix}-mid`;
  return `${prefix}-sm`;
}

/** unified-grid(心率接入,基础 28px):合法配速最长 5 字符,保持统一字号。 */
export function unifiedPaceMod(text) {
  return lenModifier(text, 'v', 5, 6);
}

/** unified-grid 距离列 84px 净宽:"10.00" 起降档。 */
export function unifiedDistMod(text) {
  return lenModifier(text, 'v', 4, 5);
}

/** unified-grid 时长列 92px 净宽:"59:59" 可容,"1:01:01" 起降档。 */
export function unifiedElapsedMod(text) {
  return lenModifier(text, 'v', 5, 5);
}

/** glasses-grid(眼镜,基础 34px)距离列 92px 净宽:"10.00" 起降档。 */
export function glassesDistMod(text) {
  return lenModifier(text, 'g', 4, 6);
}

/** glasses-grid 时长列 108px 净宽:"59:59" 可容,"1:01:01"(7字符)需最小档。 */
export function glassesElapsedMod(text) {
  return lenModifier(text, 'g', 5, 6);
}
