/**
 * Format a duration in milliseconds for the run-history table and detector
 * cards.
 *
 * Rules:
 *   - < 1000 ms         → "412 ms"
 *   - 1000..59_999 ms   → "1.3 s"   (1 decimal, trimmed trailing ".0")
 *   - 60_000..3_599_999 → "2m 4s"   (integer minutes + seconds, "s" dropped when 0)
 *   - >= 1h             → "1h 3m"   (integer hours + minutes, "m" dropped when 0)
 *
 * Negative / non-finite values collapse to "0 ms" so malformed timestamps
 * don't leak into the UI.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    const rounded = Math.round(s * 10) / 10;
    const text = rounded.toFixed(1);
    return `${text.endsWith('.0') ? text.slice(0, -2) : text} s`;
  }
  if (ms < 3_600_000) {
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
