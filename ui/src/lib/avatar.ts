/* -------------------------------------------------------------------------
   avatar.ts — deterministic avatar color + initials.
   Ported 1:1 in behavior from src/dashboard/core.js (colorFor / initials) so
   the same author always renders the same swatch across the old and new UI.
   Colors are emitted as oklch to sit inside the Tactical HUD palette.
   ------------------------------------------------------------------------- */

/** Two-letter initials from a display name. Falls back to "?" when empty. */
export function initials(name: string | undefined | null): string {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Stable background color derived from a string hash. Mid-lightness oklch so
 * white text always reads on top, hue spread across the wheel for variety.
 */
export function colorFor(str: string | undefined | null): string {
  const s = String(str ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `oklch(0.56 0.11 ${hue})`;
}
