// Usage: node scripts/verify-redirects.ts <export.json> --old <origin-ip-or-host> --new <worker-url> [--hosts <host,...>]
// Requests every exported link from both sides with the original Host header, never following redirects,
// and exits 1 when any status or Location differs.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { filterHosts, normHost, parseExport } from "./lib/export.ts";
import { compareProbe, probeTargets, type Probe } from "./lib/verify.ts";

const usage = "usage: verify-redirects.ts <export.json> --old <origin-ip-or-host> --new <worker-url> [--hosts <host,...>]";
const die = (m: string): never => { console.error(`${m}\n${usage}`); process.exit(2); };
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--old", "--new", "--hosts"].includes(args[i - 1]!)));
const oldArg = flag("--old"), newArg = flag("--new"), hostsArg = flag("--hosts");
if (!file || !oldArg || !newArg) die("export file, --old and --new are required");

const base = (s: string) => new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
const oldBase = base(oldArg!), newBase = base(newArg!);
let exp = parseExport(JSON.parse(readFileSync(file!, "utf8")));
if (hostsArg) exp = filterHosts(exp, hostsArg.split(","));

/** One GET with the original Host header; node:https (not fetch) so Host can differ from the connect address. */
function probe(b: URL, host: string, path: string, sni: boolean): Promise<Probe> {
  const mod = b.protocol === "http:" ? http : https;
  return new Promise((resolve) => {
    const req = mod.request({
      hostname: b.hostname, port: b.port || undefined, path, method: "GET", timeout: 10_000,
      headers: { host, "user-agent": "linkwarren-verify" },
      // Explicit SNI on every HTTPS probe: the original host for the old origin, the connect host otherwise (never derived from the Host header).
      ...(b.protocol === "https:" ? { servername: sni ? host : b.hostname } : {}),
    }, (res) => {
      res.resume(); // redirects are never followed
      resolve({ status: res.statusCode ?? null, location: (res.headers.location as string | undefined) ?? null });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: null, location: null, error: e.message }));
    req.end();
  });
}

const targets = probeTargets(exp);
let bad = 0, next = 0;
async function worker() {
  while (next < targets.length) {
    const t = targets[next++]!;
    const [o, n] = await Promise.all([probe(oldBase, t.host, t.path, true), probe(newBase, t.host, t.path, false)]);
    const diff = compareProbe(o, n);
    if (diff) { bad++; console.log(`MISMATCH ${normHost(t.host)}${t.path}: ${diff}`); }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`${targets.length} links checked, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
