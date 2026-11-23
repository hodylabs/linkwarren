import type { Env } from "./env";
import { getSettings, type InstanceSettings, type LatestRelease } from "./settings";
import { VERSION } from "./version";

/** The daily "update available" check (owner decision: no auto-update, only a notice). See docs/privacy.md. */
export const LATEST_URL = "https://api.github.com/repos/hodylabs/linkwarren/releases/latest";
const RELEASES_PATH = "/hodylabs/linkwarren/releases/";
// Fixed and generic: no instance name, host, email or token is ever sent.
const HEADERS = { "User-Agent": "linkwarren-update-check", Accept: "application/vnd.github+json" };
const TIMEOUT_MS = 5000;

/** `x.y.z` with an optional leading v; anything else (pre-release, build, extra parts) is null. */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = typeof v === "string" ? /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only when `a` is strictly newer than `b`; false when either is not a valid version. */
export function newer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! > pb[i]!;
  return false;
}

/** The release notes URL when it is https://github.com/hodylabs/linkwarren/releases/..., else null (parsed, never a substring match). */
export function releaseUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 300) return null;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  const ok = url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && url.pathname.startsWith(RELEASES_PATH);
  return ok ? url.href : null;
}

/** What /api/instance shows to owners and `settings` holders: only a release strictly newer than this one. */
export function updateInfo(s: InstanceSettings): { current: string; latest: string; url: string } | null {
  const l = s.updatesLatest;
  const url = l && releaseUrl(l.url);
  return s.updatesCheck && l && url && newer(l.version, VERSION) ? { current: VERSION, latest: l.version, url } : null;
}

class UpdateError extends Error {}

async function fetchLatest(): Promise<Omit<LatestRelease, "checkedAt">> {
  let res: Response;
  try {
    res = await fetch(LATEST_URL, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new UpdateError("update_network");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new UpdateError(`update_http_${res.status}`); // 404 until the first release exists, 403/429 when rate limited
  }
  const j = (await res.json().catch(() => {
    throw new UpdateError("update_bad_json");
  })) as Record<string, unknown> | null;
  const v = parseVersion(j?.tag_name);
  const url = releaseUrl(j?.html_url);
  if (!j || j.draft === true || j.prerelease === true || !v || !url) throw new UpdateError("update_bad_release");
  const p = j.published_at;
  const publishedAt = typeof p === "string" && p.length <= 40 && Number.isFinite(Date.parse(p)) ? p : null;
  return { version: v.join("."), url, publishedAt };
}

/** Daily (00:15 UTC run). Writes D1 only when the release changed; any failure keeps the stored value and logs a fixed code. Never throws. */
export async function checkUpdate(env: Env, nowSec: number): Promise<void> {
  try {
    const s = await getSettings(env);
    if (!s.updatesCheck) return;
    const r = await fetchLatest();
    const old = s.updatesLatest;
    if (old && old.version === r.version && old.url === r.url && old.publishedAt === r.publishedAt) return;
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('updates.latest', ?, ?, 'system') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    ).bind(JSON.stringify({ ...r, checkedAt: nowSec }), nowSec).run();
    console.log(`update check: latest ${r.version}`);
  } catch (e) {
    console.error("update check failed", e instanceof UpdateError ? e.message : "update_failed");
  }
}
