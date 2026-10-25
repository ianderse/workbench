/** Token counts the way the Usage page writes them: 950, 12.4K, 3.1M, 1.2B */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 999.5) return String(Math.round(count));
  let value = count;
  let suffix = '';
  for (const unit of ['K', 'M', 'B']) {
    value /= 1000;
    suffix = unit;
    // 999.96K reads as 1M, not "1000K"
    if (value < 999.95) break;
  }
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${text.replace(/\.0$/, '')}${suffix}`;
}
