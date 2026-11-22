/** After a save answers: fields changed since `sent` went out keep what was typed, the rest take the saved value. */
export function rebase<T extends object>(saved: T, sent: T, now: T): T {
  const out = { ...saved };
  for (const k of Object.keys(now) as (keyof T)[]) if (now[k] !== sent[k]) out[k] = now[k];
  return out;
}
