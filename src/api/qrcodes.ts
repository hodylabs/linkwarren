import { Hono, type Context } from "hono";
import { z } from "zod";
import { auditStmt } from "../audit";
import type { Env } from "../env";
import { canUseDomain, usableDomainsSql } from "../perm";
import { actor, type Grant } from "../principal";
import {
  BODY_MAX, DEFAULT_STYLE, ECC_LEVELS, NAME_MAX, QR_KINDS, SMS_MAX, SUBJECT_MAX, TEXT_MAX, WIFI_SECURITY,
  qrProblem, styleProblem, type QrData, type QrItem, type QrKind, type QrStyle,
} from "../qrcode";
import { actorCan, can, type Guard } from "../roles";
import { decryptValue, encryptValue, secretsReady } from "../secrets";
import { rowToLink, type UserRow } from "../types";
import { getDomain, isMember } from "./shared";

type E = { Bindings: Env; Variables: { user: UserRow; grant: Grant } };
export const qrCodes = new Hono<E>();

const forbidden = { error: "forbidden" } as const;
// shortcut: one unpaged list; page it if someone ever keeps more than this many codes.
const LIST_MAX = 500;
// shortcut: one person can never own more codes than the list shows; someone managing several people's codes still sees the
// newest LIST_MAX only. Add a cursor when an install really needs more.
const PER_PERSON_MAX = LIST_MAX;

// Shape caps sit above the real limits (src/qrcode.ts qrProblem), so those keep their own error codes.
const DATA = {
  wifi: z.strictObject({ ssid: z.string().max(128), security: z.enum(WIFI_SECURITY), hidden: z.boolean() }),
  url: z.strictObject({ url: z.string().max(4096) }),
  text: z.strictObject({ text: z.string().max(TEXT_MAX * 2) }),
  email: z.strictObject({ to: z.string().max(320), subject: z.string().max(SUBJECT_MAX).default(""), body: z.string().max(BODY_MAX).default("") }),
  phone: z.strictObject({ number: z.string().max(40) }),
  sms: z.strictObject({ number: z.string().max(40), message: z.string().max(SMS_MAX).default("") }),
  link: z.strictObject({ linkId: z.string().min(1).max(64) }),
} satisfies Record<QrKind, z.ZodType>;
const style = z.strictObject({ fg: z.string().max(7), bg: z.string().max(7), ecc: z.enum(ECC_LEVELS) });
const fields = {
  name: z.string().max(NAME_MAX * 2),
  data: z.unknown(),
  // Omitted keeps the stored Wi-Fi password, "" clears it, anything else replaces it.
  password: z.string().max(256).optional(),
  style: style.optional(),
};
const createBody = z.strictObject({ ...fields, kind: z.enum(QR_KINDS) });
const patchBody = z.strictObject({ ...fields, name: fields.name.optional(), kind: z.enum(QR_KINDS).optional(), data: z.unknown().optional() });

type Row = { id: string; name: string; kind: QrKind; data: string; secret: string | null; style: string; created_by: string; updated_by: string; created_at: number; updated_at: number; link_host?: string | null; link_slug?: string | null };
const parse = <T>(s: string, fallback: T): T => {
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
const toItem = (r: Row): QrItem => ({
  id: r.id, name: r.name, kind: r.kind, data: parse(r.data, {} as QrData[QrKind]), style: { ...DEFAULT_STYLE, ...parse(r.style, {}) },
  hasPassword: r.secret !== null, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  ...(r.kind === "link" ? { link: r.link_host && r.link_slug ? { host: r.link_host, slug: r.link_slug } : null } : {}),
});
const aad = (id: string) => `qr.${id}`;

/** Who may create or list: anyone who may create links; links.editAny holders manage everyone's. */
const mayCreate = (u: UserRow) => can(u, "links.create");
const seesAll = (u: UserRow) => can(u, "links.editAny");
const mayEdit = (u: UserRow, createdBy: string) => seesAll(u) || (createdBy === u.id && mayCreate(u));
/** SQL twin of mayEdit for a statement over qr_codes (reads its `created_by`), re-checked at write time. */
const editGuard = (userId: string): Guard => {
  const any = actorCan(userId, "links.editAny"), own = actorCan(userId, "links.create");
  return { sql: `(${any.sql} OR (created_by = ? AND ${own.sql}))`, binds: [...any.binds, userId, ...own.binds] };
};

/** Every row with its link's address resolved, limited to the domains `user` can use (an owner: all). */
function selectRows(env: Env, user: UserRow, where: string, binds: unknown[], limit = "") {
  const usable = user.role === "owner" ? "" : ` AND d.id IN (${usableDomainsSql})`;
  return env.DB.prepare(
    `SELECT q.*, d.host link_host, l.slug link_slug FROM qr_codes q
     LEFT JOIN links l ON q.kind = 'link' AND l.id = json_extract(q.data, '$.linkId')
     LEFT JOIN domains d ON d.id = l.domain_id${usable}
     WHERE ${where} ORDER BY q.created_at DESC, q.id DESC${limit}`,
  ).bind(...(usable ? [user.id] : []), ...binds);
}

qrCodes.get("/", async (c) => {
  const user = c.var.user;
  if (!mayCreate(user) && !seesAll(user)) return c.json(forbidden, 403);
  const [where, binds] = seesAll(user) ? ["1", []] : ["q.created_by = ?", [user.id]];
  const rows = (await selectRows(c.env, user, where, binds, ` LIMIT ${LIST_MAX}`).all<Row>()).results;
  return c.json({ items: rows.map(toItem) });
});

/** One code; the Wi-Fi password only here, and only to someone who may edit the code. */
qrCodes.get("/:id", async (c) => {
  const user = c.var.user;
  const row = await selectRows(c.env, user, "q.id = ?", [c.req.param("id")]).first<Row>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!mayEdit(user, row.created_by)) return c.json(forbidden, 403);
  const password = row.secret === null ? null : await decryptValue(c.env, aad(row.id), row.secret);
  if (row.secret !== null && password === null) console.warn("secrets_unreadable", "qr");
  return c.json({ ...toItem(row), password });
});

type Input = { kind: QrKind; data: QrData[QrKind] };
/** The kind's data, checked by shape then content; a link must exist on a domain the person can use. */
async function content(c: Context<E>, kind: QrKind, raw: unknown, password: string, checkLink = true): Promise<Input | { error: string }> {
  const d = DATA[kind].safeParse(raw);
  if (!d.success) return { error: "invalid_body" };
  const data = (kind === "url" ? { url: (d.data as QrData["url"]).url.trim() } : d.data) as QrData[QrKind];
  const p = qrProblem(kind, data, password);
  if (p) return { error: p };
  if (kind === "link" && checkLink) {
    const user = c.var.user;
    const row = await c.env.DB.prepare("SELECT * FROM links WHERE id = ?").bind((data as QrData["link"]).linkId).first();
    const domain = row ? await getDomain(c.env, rowToLink(row).domainId) : null;
    if (!domain || !canUseDomain(user, domain, await isMember(c.env, domain.id, user.id), c.var.grant.domains)) return { error: "qr_link" };
  }
  return { kind, data };
}
const cleanName = (n: string): string | null => {
  const t = n.trim();
  return t && [...t].length <= NAME_MAX ? t : null;
};
const checkStyle = (s: QrStyle | undefined): string | null => (s ? styleProblem(s) : null);
/** Whether this content carries a password at all (a Wi-Fi network that is not open). */
const takesPassword = (i: Input) => i.kind === "wifi" && (i.data as QrData["wifi"]).security !== "nopass";

qrCodes.post("/", async (c) => {
  const user = c.var.user;
  if (!mayCreate(user)) return c.json(forbidden, 403);
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const b = body.data;
  const name = cleanName(b.name);
  if (!name) return c.json({ error: "qr_name" }, 400);
  const sp = checkStyle(b.style);
  if (sp) return c.json({ error: sp }, 400);
  const input = await content(c, b.kind, b.data, b.password ?? "");
  if ("error" in input) return c.json(input, 400);
  const id = crypto.randomUUID();
  const pw = takesPassword(input) && b.password ? b.password : null;
  if (pw && !secretsReady(c.env)) return c.json({ error: "secrets_key_missing" }, 409);
  const secret = pw ? await encryptValue(c.env, aad(id), pw) : null;
  const now = Math.floor(Date.now() / 1000);
  const s = b.style ?? DEFAULT_STYLE;
  const may = actorCan(user.id, "links.create");
  const room = { sql: `(SELECT COUNT(*) FROM qr_codes WHERE created_by = ?) < ${PER_PERSON_MAX}`, binds: [user.id] };
  const res = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO qr_codes (id,name,kind,data,secret,style,created_by,updated_by,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${may.sql} AND ${room.sql}`)
      .bind(id, name, input.kind, JSON.stringify(input.data), secret, JSON.stringify(s), user.id, user.id, now, now, ...may.binds, ...room.binds),
    auditStmt(c.env, { ...actor(c), action: "qr.create", targetType: "qr_code", targetId: id, detail: { name, kind: input.kind, ...(secret ? { password: "set" } : {}) } },
      { sql: "EXISTS (SELECT 1 FROM qr_codes WHERE id = ?)", binds: [id] }),
  ]);
  if (!res[0]!.meta.changes) return (await holds(c.env, may)) ? c.json({ error: "too_many_qr_codes" }, 409) : c.json(forbidden, 403);
  const row = await selectRows(c.env, user, "q.id = ?", [id]).first<Row>();
  return c.json(toItem(row!), 201);
});

const holds = async (env: Env, g: Guard) => !!(await env.DB.prepare(`SELECT ${g.sql} ok`).bind(...g.binds).first<{ ok: number }>())?.ok;

/** A guarded write that changed nothing: gone (404), no longer allowed (403), or changed meanwhile (409). */
async function lost(c: Context<E>, id: string) {
  const g = editGuard(c.var.user.id);
  const r = await c.env.DB.prepare(`SELECT ${g.sql} ok FROM qr_codes WHERE id = ?`).bind(...g.binds, id).first<{ ok: number }>();
  return !r ? c.json({ error: "not_found" }, 404) : !r.ok ? c.json(forbidden, 403) : c.json({ error: "conflict" }, 409);
}

async function editable(c: Context<E>, id: string): Promise<Row | { status: 403 | 404 }> {
  const row = await c.env.DB.prepare("SELECT * FROM qr_codes WHERE id = ?").bind(id).first<Row>();
  if (!row) return { status: 404 };
  return mayEdit(c.var.user, row.created_by) ? row : { status: 403 };
}

qrCodes.patch("/:id", async (c) => {
  const user = c.var.user;
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_body" }, 400);
  const b = body.data;
  // A new kind needs its data.
  if (b.kind !== undefined && b.data === undefined) return c.json({ error: "invalid_body" }, 400);
  const row = await editable(c, c.req.param("id"));
  if ("status" in row) return c.json({ error: row.status === 404 ? "not_found" : "forbidden" }, row.status);
  const name = b.name === undefined ? row.name : cleanName(b.name);
  if (!name) return c.json({ error: "qr_name" }, 400);
  const sp = checkStyle(b.style);
  if (sp) return c.json({ error: sp }, 400);
  const kind = b.kind ?? row.kind;
  // The password the code will carry: the new one, or the stored one (only to size the payload).
  const kept = b.password === undefined && row.secret !== null ? ((await decryptValue(c.env, aad(row.id), row.secret)) ?? "") : "";
  // Unchanged content is checked again (a new password must still fit); the link's domain is re-checked only when the content
  // changes, so someone allowed to manage the code can rename it without access to the link's domain.
  const input = await content(c, kind, b.data ?? parse(row.data, {}), b.password ?? kept, b.kind !== undefined || b.data !== undefined);
  if ("error" in input) return c.json(input, 400);
  let secret = row.secret;
  if (!takesPassword(input) || b.password === "") secret = null;
  else if (b.password !== undefined) {
    if (!secretsReady(c.env)) return c.json({ error: "secrets_key_missing" }, 409);
    secret = await encryptValue(c.env, aad(row.id), b.password);
  }
  const change = secret === row.secret ? undefined : secret ? "set" : "cleared";
  const now = Math.max(Math.floor(Date.now() / 1000), row.updated_at + 1); // updated_at is the revision: always forward
  const s = b.style ?? parse(row.style, DEFAULT_STYLE);
  const g = editGuard(user.id);
  const rev = { sql: "id = ? AND updated_at = ?", binds: [row.id, row.updated_at] };
  const res = await c.env.DB.batch([
    auditStmt(c.env, { ...actor(c), action: "qr.update", targetType: "qr_code", targetId: row.id, detail: { name, kind: input.kind, ...(change ? { password: change } : {}) } },
      { sql: `EXISTS (SELECT 1 FROM qr_codes WHERE ${rev.sql} AND ${g.sql})`, binds: [...rev.binds, ...g.binds] }),
    c.env.DB.prepare(`UPDATE qr_codes SET name=?, kind=?, data=?, secret=?, style=?, updated_by=?, updated_at=? WHERE ${rev.sql} AND ${g.sql}`)
      .bind(name, input.kind, JSON.stringify(input.data), secret, JSON.stringify(s), user.id, now, ...rev.binds, ...g.binds),
  ]);
  if (!res[1]!.meta.changes) return lost(c, row.id);
  const next = await selectRows(c.env, user, "q.id = ?", [row.id]).first<Row>();
  return c.json(toItem(next!));
});

qrCodes.delete("/:id", async (c) => {
  const user = c.var.user;
  const row = await editable(c, c.req.param("id"));
  if ("status" in row) return c.json({ error: row.status === 404 ? "not_found" : "forbidden" }, row.status);
  const g = editGuard(user.id);
  const res = await c.env.DB.batch([
    auditStmt(c.env, { ...actor(c), action: "qr.delete", targetType: "qr_code", targetId: row.id, detail: { name: row.name, kind: row.kind } },
      { sql: `EXISTS (SELECT 1 FROM qr_codes WHERE id = ? AND ${g.sql})`, binds: [row.id, ...g.binds] }),
    c.env.DB.prepare(`DELETE FROM qr_codes WHERE id = ? AND ${g.sql}`).bind(row.id, ...g.binds),
  ]);
  if (!res[1]!.meta.changes) return lost(c, row.id);
  return c.body(null, 204);
});
