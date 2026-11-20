import type { AuditItem } from "../api";

export type AuditText = { who: string; via: string | null; text: string; code: string | null; suffix: string };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Plain-language parts of one audit row. Every value is text for React to escape; nothing here is HTML. */
export function describeAudit(a: AuditItem, meId: string): AuditText {
  const who = a.actorId === meId ? "You" : a.actorName || a.actorEmail || "A deleted user";
  const via = a.via ? `via ${a.via}` : null;
  const host = str(a.detail.host);
  const slug = str(a.detail.slug);
  const link = host && slug ? `${host}/${slug}` : `${a.targetType} ${a.targetId}`;
  const done = (text: string, code: string | null = null, suffix = ""): AuditText => ({ who, via, text, code, suffix });
  switch (a.action) {
    case "link.create": return done("created", link);
    case "link.update": return done("changed the destination of", link);
    case "link.delete": return done("deleted", link, ". The slug is locked, visits go to the domain's not-found page");
    case "domain.create": return done("added the domain", host ?? a.targetId);
    case "domain.approve": return done("approved", host ?? a.targetId);
    case "domain.disable": return done("disabled", host ?? a.targetId);
    case "domain.update": return done("changed the settings of", host ?? a.targetId);
    case "domain.members": return done("changed who can use", host ?? a.targetId);
    case "lock.release": return done("released the locked slug", host ?? a.targetId);
    case "user.bootstrap": return done("set up this linkwarren");
    case "user.activate": return done("signed in for the first time");
    case "import.run": {
      const p = num(a.detail.planned), s = num(a.detail.skipped);
      return done("imported links", null, p !== null && s !== null ? ` (${p} planned, ${s} skipped)` : "");
    }
    case "import.chunk": return done("imported a batch of links");
    default: return done(a.action, `${a.targetType} ${a.targetId}`);
  }
}
