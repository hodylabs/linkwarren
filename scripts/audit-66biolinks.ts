// Usage: node scripts/audit-66biolinks.ts <export.json> --exclude <host,...> --out audit.csv
// Writes every link that the import would NOT bring over to a local CSV. Sends nothing anywhere.
import { readFileSync, writeFileSync } from "node:fs";
import { excludedRows, parseExport, toCsv } from "./lib/export.ts";

const usage = "usage: audit-66biolinks.ts <export.json> --exclude <host,...> --out audit.csv";
const die = (m: string): never => { console.error(`${m}\n${usage}`); process.exit(2); };
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--exclude", "--out"].includes(args[i - 1]!)));
const exclude = flag("--exclude"), out = flag("--out");
if (!file) die("missing export file");
if (!exclude) die("--exclude is required (the hosts being imported)");
if (!out) die("--out is required");

const rows = excludedRows(parseExport(JSON.parse(readFileSync(file!, "utf8"))), exclude!.split(","));
writeFileSync(out!, toCsv(rows), { mode: 0o600 });
console.log(`wrote ${rows.length} excluded links to ${out}`);
