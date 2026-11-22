import { z } from "zod";
import { CfError } from "./api";

const doh = z.object({ Status: z.number(), Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional() });
const TYPE_NUM = { CNAME: 5, A: 1, AAAA: 28 } as const;
const clean = (s: string) => s.toLowerCase().replace(/\.$/, "");

/** Answers of the requested type only. NXDOMAIN or an empty NOERROR is []; every other failure throws CfError so an outage never reads as "missing". */
export async function dohLookup(name: string, type: "CNAME" | "A" | "AAAA"): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CfError(0);
  }
  if (!res.ok) throw new CfError(res.status);
  const p = doh.safeParse(await res.json().catch(() => null));
  if (!p.success || (p.data.Status !== 0 && p.data.Status !== 3)) throw new CfError(res.status);
  return (p.data.Answer ?? []).filter((a) => a.type === TYPE_NUM[type]).map((a) => clean(a.data));
}

// shortcut: Cloudflare's published proxy ranges (cloudflare.com/ips), inlined so no fetch is needed; update when that list changes.
const CF_V4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20",
  "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];
// Every IPv6 range is /29 or /32, so only the first 32 bits matter.
const CF_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];
const v4 = (ip: string) => {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0 : null;
};
/** The first 32 bits of an IPv6 address, or null. */
const v6hi = (ip: string) => {
  const [head = "", tail] = ip.split("::");
  const g = head ? head.split(":") : [];
  if (tail === undefined && g.length !== 8) return null;
  while (g.length < 2) g.push("0");
  const [a, b] = g.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return Number.isNaN(a) || Number.isNaN(b) ? null : ((a! << 16) | b!) >>> 0;
};
const inRange = (n: number | null, base: number | null, bits: number) =>
  n !== null && base !== null && (bits === 0 || (n >>> (32 - bits)) === (base >>> (32 - bits)));
export const cloudflareProxied = (ip: string) => ip.includes(":")
  ? CF_V6.some((r) => { const [b, l] = r.split("/"); return inRange(v6hi(ip), v6hi(b!), Number(l)); })
  : CF_V4.some((r) => { const [b, l] = r.split("/"); return inRange(v4(ip), v4(b!), Number(l)); });

/**
 * `served`: Cloudflare reports the custom hostname active with its certificate issued. A host proxied by its own Cloudflare zone
 * hides its CNAME and answers with that zone's edge IPs, which need not match the target's; HTTP validation passing means its
 * requests do reach the SaaS zone, so such a host reads found instead of wrong_target, but only while every A/AAAA answer is a
 * Cloudflare proxy address (an address elsewhere means some requests bypass Cloudflare). A visible CNAME elsewhere stays wrong_target.
 */
export async function dnsPointsAt(host: string, target: string, served = false): Promise<"found" | "missing" | "wrong_target" | "unknown"> {
  try {
    const t = clean(target);
    const cname = await dohLookup(host, "CNAME");
    if (cname.includes(t)) return "found";
    // A visible CNAME is the whole answer: an address shared through some other name proves nothing about this host.
    if (cname.length > 0) return "wrong_target";
    const [a, aaaa, ta, taaaa] = await Promise.all([dohLookup(host, "A"), dohLookup(host, "AAAA"), dohLookup(t, "A"), dohLookup(t, "AAAA")]);
    const theirs = new Set([...ta, ...taaaa]);
    const ips = [...a, ...aaaa];
    // Flattened apex: it shares the target's addresses, and no answer points anywhere Cloudflare does not proxy.
    if (ips.some((ip) => theirs.has(ip)) && ips.every((ip) => theirs.has(ip) || cloudflareProxied(ip))) return "found";
    if (ips.length === 0) return "missing";
    return served && ips.every(cloudflareProxied) ? "found" : "wrong_target";
  } catch (e) {
    if (e instanceof CfError) return "unknown";
    throw e;
  }
}
