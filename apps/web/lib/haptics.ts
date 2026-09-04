/**
 * Haptics (spec §3).
 *
 * `navigator.vibrate` is absent on iOS Safari and desktop, so every call is
 * guarded. Never awaited, never branched on — haptics are a garnish, and code
 * that depends on them breaks on half the devices that matter.
 */
type Pattern = 'tap' | 'capture' | 'success' | 'warn';
const PATTERNS: Record<Pattern, number | number[]> = {
  tap: 8, capture: [12, 40, 24], success: [10, 60, 10], warn: [30, 60, 30],
};

export function haptic(pattern: Pattern = 'tap') {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try { navigator.vibrate(PATTERNS[pattern]); } catch { /* not fatal */ }
}
