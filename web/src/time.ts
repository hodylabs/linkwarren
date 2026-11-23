const pad = (n: number) => String(n).padStart(2, "0");

/** Epoch seconds to the value a datetime-local input takes (local time, minute precision). "" for none. */
export function toLocalInput(sec: number | null): string {
  if (sec === null) return "";
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value back to epoch seconds; empty or unreadable is null. */
export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/** "Nov 12". */
export const shortDate = (sec: number): string => new Date(sec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const dayStart = (ms: number) => new Date(new Date(ms).toDateString()).getTime();

/** "10:42" today, "Yesterday", else the short date. */
export function clock(sec: number, nowMs = Date.now()): string {
  const days = Math.round((dayStart(nowMs) - dayStart(sec * 1000)) / 86_400_000);
  if (days === 0) {
    const d = new Date(sec * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return days === 1 ? "Yesterday" : shortDate(sec);
}

/** The viewer's zone for busiest times: the IANA name, or the current offset in minutes when the browser gives none. */
export function viewerZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (z) return z;
  } catch {
    // fall through to the offset
  }
  return String(-new Date().getTimezoneOffset());
}
