import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// S8c R11: in path mode the app lives under a prefix, so every absolute dashboard URL must go through the base helpers
// (withBase, stripBase, navigate, NavLink, api). This scans the app source for the ways one could slip past them.
const ROOT = join(process.cwd(), "web/src");
const SKIP = new Set(["base.ts", "api.ts"]); // the helpers themselves

const Q = "[\"'`]";
const RULES: { name: string; bad: RegExp; ok?: RegExp }[] = [
  // An inner dashboard path as a literal is fine only as the argument of a helper that adds or strips the base.
  { name: "dashboard path literal", bad: new RegExp(`${Q}/(linkwarren-mark|sign-in|join\\b|mcp\\b)`), ok: /\b(withBase|stripBase|navigate)\(|\bto=|\bapi(<[^>]*>)?\(/ },
  // API paths travel to api(), which adds the base; these sinks would send them raw.
  { name: "API path in a raw sink", bad: new RegExp(`(\\bsrc=|\\bhref=|\\bfetch\\(|\\bassign\\(|new URL\\(|State\\([^)]*,)\\s*\\{?${Q}/(api|auth)/`) },
  // Root-absolute attributes and navigations. Access sign-out is a Cloudflare path and Access mode never runs under a prefix (R14).
  { name: "root-absolute src/href", bad: /\b(src|href)=\{?["'`]\/(?!\/)/, ok: /href="\/cdn-cgi\/access\/logout"/ },
  { name: "raw location.assign", bad: /location\.assign\(\s*["'`]\// },
  { name: "raw history URL", bad: /history\.(push|replace)State\([^)]*,\s*["'`]\// },
  { name: "raw pathname compare", bad: /location\.pathname\s*[!=]==|[!=]==\s*location\.pathname/ },
  { name: "host-built dashboard URL", bad: /\$\{location\.host\}\// },
];

function scan(file: string, text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments
    for (const r of RULES) if (r.bad.test(line) && !r.ok?.test(line)) hits.push(`${file}:${i + 1} ${r.name}: ${line.trim()}`);
  });
  return hits;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") && !SKIP.has(e.name) ? [p] : [];
  });
}

describe("no absolute dashboard paths outside the base helpers", () => {
  it("the rules catch each known bad shape and allow the helper calls", () => {
    const bad = [
      '<img src="/linkwarren-mark.svg" alt="" />', 'const u = "/linkwarren-mark.svg";', 'location.assign("/");', 'history.replaceState(null, "", "/sign-in");',
      'if (location.pathname === "/join") x();', "const url = `https://${location.host}/mcp`;", 'fetch("/api/me")', '<a href="/links">',
    ];
    for (const l of bad) expect(scan("x", l).length, l).toBeGreaterThan(0);
    const good = [
      '<img src={withBase("/linkwarren-mark.svg")} alt="" />', 'navigate("/links")', '<NavLink to="/links">', 'await api("POST", "/api/account/sign-out", {});',
      'const onSignInPage = () => stripBase(location.pathname) === "/sign-in";', '<a href="/cdn-cgi/access/logout">Sign out</a>', 'const path = `/api/users/${id}`;',
      '<a href="https://example.com/x">',
    ];
    for (const l of good) expect(scan("x", l), l).toEqual([]);
  });

  it("web/src has none", () => {
    const files = sources(ROOT);
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((f) => scan(relative(ROOT, f), readFileSync(f, "utf8")))).toEqual([]);
  });
});
