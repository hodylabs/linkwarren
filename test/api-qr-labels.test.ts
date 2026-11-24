// S13 QR print labels: /api/links/:id/qr-labels, the link's edit right on every route, at most 20 per link, every change audited.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { labelCode, QR_LABELS_MAX } from "../src/api/links";
import { MEMBER_DEFAULT } from "../src/roles";
import { dash, setupAccess, tokenFor } from "./helpers/access";
import { beforeBatch } from "./helpers/race";

const run = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).run();
const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())!.n;
async function call(who: string, method: string, path: string, body?: unknown) {
  return dash(`/api/links/${path}`, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await tokenFor(`${who}@example.com`), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const answer = async (r: Response): Promise<[number, any]> => [r.status, r.status === 204 ? null : await r.json()];

beforeAll(setupAccess);
beforeEach(async () => {
  await env.DB.batch(["qr_labels", "links", "audit_log", "domain_members", "domains", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await run("DELETE FROM roles WHERE builtin = 0");
  await run("UPDATE roles SET perms = ? WHERE id = 'member'", JSON.stringify(MEMBER_DEFAULT));
  await run("INSERT INTO roles (id,name,perms,builtin,created_at,updated_at) VALUES ('ro','Viewer','[]',0,1,1)");
  for (const [id, roleId] of [["owner", null], ["a", null], ["b", null], ["v", "ro"]])
    await run("INSERT INTO users (id,email,role,role_id,status,created_at) VALUES (?,?,?,?,'active',1)", id, `${id}@example.com`, id === "owner" ? "owner" : "member", roleId);
  await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dm','go.example.com','main','active','owner',1)");
  const link = (id: string, by: string, fw: string | null = null) =>
    run("INSERT INTO links (id,domain_id,slug,slug_key,url,created_by,updated_by,created_at,updated_at,forward_to) VALUES (?,'dm',?,?,'https://example.com/',?,?,1,1,?)", id, id, id, by, by, fw);
  await link("la", "a");
  await link("lb", "b");
  await link("lv", "v");
  await link("lf", "a", "la");
});

describe("labelCode", () => {
  it("6 characters from [a-z0-9], and a valid print code", () => {
    const seen = new Set(Array.from({ length: 200 }, labelCode));
    for (const c of seen) expect(c).toMatch(/^[a-z0-9]{6}$/);
    expect(seen.size).toBeGreaterThan(190);
  });
});

describe("QR labels", () => {
  it("create, list, rename and delete, each change audited with the code and label", async () => {
    const [st, made] = await answer(await call("a", "POST", "la/qr-labels", { label: "  Flyer " }));
    expect(st).toBe(201);
    expect(made).toMatchObject({ label: "Flyer", code: expect.stringMatching(/^[a-z0-9]{6}$/), createdAt: expect.any(Number) });
    expect(await answer(await call("a", "GET", "la/qr-labels"))).toEqual([200, { items: [made] }]);
    expect(await answer(await call("a", "PATCH", `la/qr-labels/${made.id}`, { label: "Business card" }))).toEqual([200, { ...made, label: "Business card" }]);
    expect(await answer(await call("a", "DELETE", `la/qr-labels/${made.id}`))).toEqual([204, null]);
    expect(await answer(await call("a", "GET", "la/qr-labels"))).toEqual([200, { items: [] }]);
    const audit = (await env.DB.prepare("SELECT action, target_type, target_id, detail FROM audit_log ORDER BY id").all<{ action: string; target_type: string; target_id: string; detail: string }>()).results;
    expect(audit.map((r) => [r.action, r.target_type, r.target_id])).toEqual([["qr_label.create", "link", "la"], ["qr_label.rename", "link", "la"], ["qr_label.delete", "link", "la"]]);
    expect(JSON.parse(audit[1]!.detail)).toEqual({ host: "go.example.com", slug: "la", code: made.code, label: "Business card", from: "Flyer" });
  });
  it("only someone who may edit the link: another member is 403 on every route, nothing written or audited", async () => {
    await run("INSERT INTO qr_labels (id,link_id,code,label,created_at) VALUES ('q1','la','abc123','Flyer',1)");
    for (const [m, p, b] of [["GET", "la/qr-labels"], ["POST", "la/qr-labels", { label: "x" }], ["PATCH", "la/qr-labels/q1", { label: "x" }], ["DELETE", "la/qr-labels/q1"]] as const)
      expect(await answer(await call("b", m, p, b))).toEqual([403, { error: "forbidden" }]);
    expect(await count("audit_log")).toBe(0);
    expect((await call("owner", "GET", "la/qr-labels")).status).toBe(200); // the owner may edit any link
  });
  it("a role without links.create cannot label even its own earlier link", async () => {
    expect((await call("v", "POST", "lv/qr-labels", { label: "x" })).status).toBe(403);
  });
  it("unknown link, unknown label, or another link's label id are 404", async () => {
    await run("INSERT INTO qr_labels (id,link_id,code,label,created_at) VALUES ('qb','lb','bbb222','B',1)");
    expect((await call("a", "GET", "nope/qr-labels")).status).toBe(404);
    expect((await call("a", "PATCH", "la/qr-labels/ghost", { label: "x" })).status).toBe(404);
    expect((await call("owner", "PATCH", "la/qr-labels/qb", { label: "x" })).status).toBe(404);
    expect((await call("owner", "DELETE", "la/qr-labels/qb")).status).toBe(404);
    expect(await count("qr_labels")).toBe(1);
  });
  it("labels: trimmed, 1-100 characters, no control characters; strict body", async () => {
    for (const body of [{ label: "" }, { label: "   " }, { label: "x".repeat(101) }, { label: "a\u0007b" }])
      expect(await answer(await call("a", "POST", "la/qr-labels", body))).toEqual([400, { error: "bad_label" }]);
    for (const body of [{}, { label: 1 }, { label: "x", code: "abc123" }])
      expect(await answer(await call("a", "POST", "la/qr-labels", body))).toEqual([400, { error: "invalid_body" }]);
    expect(await count("qr_labels")).toBe(0);
  });
  it(`at most ${QR_LABELS_MAX} per link: the next is 409 too_many_labels and not audited`, async () => {
    for (let i = 0; i < QR_LABELS_MAX; i++) await run("INSERT INTO qr_labels (id,link_id,code,label,created_at) VALUES (?,'la',?,'x',1)", `q${i}`, `c${String(i).padStart(5, "0")}`);
    await run("DELETE FROM audit_log");
    expect(await answer(await call("a", "POST", "la/qr-labels", { label: "one more" }))).toEqual([409, { error: "too_many_labels" }]);
    expect([await count("qr_labels"), await count("audit_log")]).toEqual([QR_LABELS_MAX, 0]);
  });
  it("a rename racing another rename is 409 and not audited, so an audit's `from` is always the label it replaced", async () => {
    await run("INSERT INTO qr_labels (id,link_id,code,label,created_at) VALUES ('q1','la','abc123','A',1)");
    const restore = beforeBatch(2, () => run("UPDATE qr_labels SET label = 'B' WHERE id = 'q1'"));
    let r;
    try { r = await call("a", "PATCH", "la/qr-labels/q1", { label: "C" }); } finally { restore(); }
    expect(await answer(r)).toEqual([409, { error: "conflict" }]);
    expect((await env.DB.prepare("SELECT label FROM qr_labels WHERE id = 'q1'").first<{ label: string }>())!.label).toBe("B");
    expect(await count("audit_log")).toBe(0);
  });
  it("a label write racing a move of the link to another domain writes nothing (pinned to the domain read)", async () => {
    await run("INSERT INTO domains (id,host,type,status,owner_id,created_at) VALUES ('dx','other.example.com','private','active','b',1)");
    await run("INSERT INTO qr_labels (id,link_id,code,label,created_at) VALUES ('q1','la','abc123','A',1)");
    const move = () => run("UPDATE links SET domain_id = 'dx' WHERE id = 'la'");
    for (const [m, p, b] of [["POST", "la/qr-labels", { label: "x" }], ["PATCH", "la/qr-labels/q1", { label: "x" }], ["DELETE", "la/qr-labels/q1"]] as const) {
      await run("UPDATE links SET domain_id = 'dm' WHERE id = 'la'");
      const restore = beforeBatch(2, move);
      let r;
      try { r = await call("a", m, p, b); } finally { restore(); }
      expect([m, r.status]).toEqual([m, 409]);
    }
    expect(await count("qr_labels")).toBe(1);
    expect((await env.DB.prepare("SELECT label FROM qr_labels").first<{ label: string }>())!.label).toBe("A");
    expect(await count("audit_log")).toBe(0);
  });
  it("a forwarder takes no labels; deleting the link deletes its labels", async () => {
    expect(await answer(await call("a", "POST", "lf/qr-labels", { label: "x" }))).toEqual([409, { error: "forwarder" }]);
    await run("INSERT INTO qr_labels (id,link_id,code,label,created_at) VALUES ('q1','la','abc123','Flyer',1)");
    expect((await call("a", "DELETE", "la")).status).toBe(204);
    expect(await count("qr_labels")).toBe(0);
  });
});
