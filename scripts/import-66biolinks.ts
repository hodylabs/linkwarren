// Usage: node scripts/import-66biolinks.ts <export.json> --api https://<dashboard> --hosts <host,...> [--dry-run]
// Needs env CF_ACCESS_TOKEN (cloudflared access login https://<dashboard>), sent as header cf-access-token.
import { readFileSync } from "node:fs";
import { chunkLinks, filterHosts, normHost, parseExport } from "./lib/export.ts";

const CHUNK = 500;
const usage = "usage: import-66biolinks.ts <export.json> --api https://<dashboard> --hosts <host,...> [--dry-run]";
const die = (m: string, code = 2): never => { console.error(`${m}\n${usage}`); process.exit(code); };

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--api", "--hosts"].includes(args[i - 1]!)));
const hostsArg = flag("--hosts"), api = flag("--api"), dry = args.includes("--dry-run");
if (!file) die("missing export file");
if (!hostsArg || !hostsArg.split(",").some((h) => h.trim())) die("--hosts is required (comma-separated list of hosts to import)");
if (!api || !/^https:\/\/|^http:\/\/localhost[:/]/.test(api)) die("--api must be an https URL");
const token = process.env.CF_ACCESS_TOKEN;
if (!token) die("CF_ACCESS_TOKEN is not set (run: cloudflared access login <api url>)");

const hosts = hostsArg!.split(",").map(normHost).filter(Boolean);
const exp = filterHosts(parseExport(JSON.parse(readFileSync(file!, "utf8"))), hosts);
console.log(`${dry ? "DRY RUN: " : ""}importing ${exp.links.length} links, ${exp.domains.length} domains for hosts: ${hosts.join(", ")}`);

type Report = { created: number; skipped: number; conflicts: { host: string; slug: string; reason: string }[]; caseSensitiveDomains: string[]; domainsCreated: string[]; ignored: { host: string; field: string }[] };
const total: Report = { created: 0, skipped: 0, conflicts: [], caseSensitiveDomains: [], domainsCreated: [], ignored: [] };
let chunks;
try { chunks = chunkLinks(exp, CHUNK); } catch (e) { die((e as Error).message); }
const uniq = (a: string[]) => [...new Set(a)];
const summary = () => {
  console.log(`created ${total.created}, skipped ${total.skipped}, conflicts ${total.conflicts.length}`);
  console.log(`domains created: ${uniq(total.domainsCreated).join(", ") || "none"}`);
  console.log(`case-sensitive domains: ${uniq(total.caseSensitiveDomains).join(", ") || "none"}`);
  for (const i of total.ignored) console.log(`ignored invalid ${i.field} on ${i.host}`);
  for (const c of total.conflicts) console.log(`conflict ${c.reason}: ${c.host}/${c.slug}`);
};
for (const links of chunks!) {
  const res = await fetch(new URL(`/api/import${dry ? "?dryRun=1" : ""}`, api), {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", "cf-access-token": token! },
    body: JSON.stringify({ mainHost: exp.mainHost, domains: exp.domains, links }),
  });
  if (!res.ok) { console.log("totals of completed chunks before the failure:"); summary(); console.error(`import failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); process.exit(1); }
  const r = (await res.json()) as Report;
  total.created += r.created; total.skipped += r.skipped;
  total.conflicts.push(...r.conflicts); total.ignored.push(...r.ignored);
  total.caseSensitiveDomains.push(...r.caseSensitiveDomains); total.domainsCreated.push(...r.domainsCreated);
}
summary();
