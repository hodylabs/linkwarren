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

export async function dnsPointsAt(host: string, target: string): Promise<"found" | "missing" | "wrong_target" | "unknown"> {
  try {
    const t = clean(target);
    const cname = await dohLookup(host, "CNAME");
    if (cname.includes(t)) return "found";
    const [a, aaaa, ta, taaaa] = await Promise.all([dohLookup(host, "A"), dohLookup(host, "AAAA"), dohLookup(t, "A"), dohLookup(t, "AAAA")]);
    const theirs = new Set([...ta, ...taaaa]);
    if ([...a, ...aaaa].some((ip) => theirs.has(ip))) return "found"; // flattened apex
    return cname.length + a.length + aaaa.length === 0 ? "missing" : "wrong_target";
  } catch (e) {
    if (e instanceof CfError) return "unknown";
    throw e;
  }
}
