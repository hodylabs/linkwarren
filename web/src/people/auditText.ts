import type { AuditItem } from "../api";

export type AuditText = { who: string; via: string | null; text: string; code: string | null; suffix: string };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Plain-language parts of one audit row. Every value is text for React to escape; nothing here is HTML. */
export function describeAudit(a: AuditItem, meId: string, domains: readonly { id: string; host: string }[] = [], users: readonly { id: string; email: string }[] = []): AuditText {
  const who = a.actorId === meId ? "You" : a.actorId === "system" ? "linkwarren" : a.actorName || a.actorEmail || "A deleted user";
  const via = a.via ? `via ${a.via}` : null;
  const host = str(a.detail.host);
  const slug = str(a.detail.slug);
  const link = host && slug ? `${host}/${slug}` : `${a.targetType} ${a.targetId}`;
  const done = (text: string, code: string | null = null, suffix = ""): AuditText => ({ who, via, text, code, suffix });
  switch (a.action) {
    case "link.create": return str(a.detail.copiedFrom) && host && slug ? done("copied", slug, ` to ${host}`) : done("created", link);
    case "link.move": {
      const from = str(a.detail.fromHost), to = str(a.detail.toHost);
      return done("moved", from && slug ? `${from}/${slug}` : link, `${to ? ` to ${to}` : ""}, the old address forwards`);
    }
    case "link.update": return done("changed", link); // detail does not say which field changed
    case "link.delete": return done("deleted", link, ". The slug is locked, visits go to the domain's not-found page");
    case "domain.create": return done("added the domain", host ?? a.targetId);
    case "domain.approve": return done("approved", host ?? a.targetId);
    case "domain.disable": return done("disabled", host ?? a.targetId);
    case "domain.update": return done("changed the settings of", host ?? a.targetId);
    case "domain.members": return done("changed who can use", host ?? a.targetId);
    case "lock.release": {
      // The server writes targetId "<domainId>/<key>" and detail { domainId, slugKeys }.
      const lockHost = domains.find((x) => x.id === str(a.detail.domainId))?.host;
      const key = a.targetId.slice(a.targetId.indexOf("/") + 1);
      return done("released the locked slug", lockHost && a.targetId.includes("/") ? `${lockHost}/${key}` : a.targetId);
    }
    case "user.bootstrap": return done("set up this linkwarren");
    case "user.activate": return done("signed in for the first time");
    case "auth.sign_in": return done(a.detail.method === "passkey" ? "signed in with a passkey" : "signed in with an email link");
    case "auth.sign_out": return done("signed out");
    case "auth.sign_out_all": return done("signed out everywhere");
    case "session.end": return done("ended a session");
    case "session.end_all": return done("signed", users.find((u) => u.id === a.targetId)?.email ?? a.targetId, " out everywhere");
    case "passkey.add": return done("added the passkey", str(a.detail.name));
    case "passkey.rename": return done("renamed a passkey to", str(a.detail.name));
    case "passkey.remove": return done("removed a passkey");
    case "audit.purge": {
      const n = num(a.detail.deleted);
      return done("removed audit entries older than 3 years", null, n !== null ? ` (${n})` : "");
    }
    case "import.run": {
      const p = num(a.detail.planned), s = num(a.detail.skipped);
      return done("imported links", null, p !== null && s !== null ? ` (${p} planned, ${s} skipped)` : "");
    }
    case "import.chunk": return done("imported a batch of links");
    case "agent.connect": return done("connected an agent", str(a.detail.clientName) ?? str(a.via));
    case "agent.access": return done("changed what an agent can do");
    // A failed approval is written as a disconnect with { reason: "failed" }; the client is in via.
    case "agent.disconnect": return a.detail.reason === "failed" ? done("failed to connect") : done("disconnected an agent", str(a.detail.clientName));
    case "key.create": return done("created the API key", str(a.detail.name));
    case "key.revoke": return done("revoked an API key");
    default: return done(a.action, `${a.targetType} ${a.targetId}`);
  }
}
