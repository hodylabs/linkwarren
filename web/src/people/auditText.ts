import type { AuditItem } from "../api";

export type AuditText = { who: string; via: string | null; text: string; code: string | null; suffix: string };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Plain-language parts of one audit row. Every value is text for React to escape; nothing here is HTML. */
export function describeAudit(a: AuditItem, meId: string, domains: readonly { id: string; host: string }[] = [], users: readonly { id: string; email: string; name?: string | null }[] = []): AuditText {
  const who = a.actorId === meId ? "You" : a.actorId === "system" ? "linkwarren" : a.actorName || a.actorEmail || "A deleted user";
  const via = a.via ? `via ${a.via}` : null;
  const host = str(a.detail.host);
  const slug = str(a.detail.slug);
  const link = host && slug ? `${host}/${slug}` : `${a.targetType} ${a.targetId}`;
  const done = (text: string, code: string | null = null, suffix = ""): AuditText => ({ who, via, text, code, suffix });
  // The person acted on: the email the server wrote, else the current list, else the raw target.
  const person = str(a.detail.email) ?? users.find((u) => u.id === a.targetId)?.email ?? `${a.targetType} ${a.targetId}`;
  const secret = a.detail.name === "RESEND_API_KEY" ? "Resend key" : "Cloudflare token";
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
    case "settings.update": {
      const key = str(a.detail.key) ?? "";
      if (key === "mcp.enabled") return done(a.detail.value === "1" ? "turned agent connections on" : "turned agent connections off");
      if (key === "instance.name") return done("renamed the instance");
      if (key === "instance.mainDomainId") return done("changed the main domain");
      if (key.startsWith("links.default")) return done("changed link defaults");
      return done("changed instance settings");
    }
    case "secret.update": return done(`saved the ${secret}`);
    case "secret.delete": return done(`removed the saved ${secret}`);
    case "logo.update": return done("changed the logo");
    case "logo.remove": return done("removed the logo");
    case "setup.complete": return done("finished the first-run setup");
    case "export.run": return done("downloaded a full export");
    case "email.test": return done("sent a test email");
    case "user.invite": {
      const hosts = Array.isArray(a.detail.domains) ? a.detail.domains.filter((h): h is string => typeof h === "string") : [];
      return done("invited", person, a.detail.role === "owner" ? " as an owner" : ` with access to ${hosts.length ? hosts.join(", ") : "the main domain"}`);
    }
    case "user.invite_resend": return done("re-sent the invite to", person);
    case "user.revoke": return done("revoked the invite for", person);
    case "user.role": return done("made", person, a.detail.to === "owner" ? " an owner" : " a member");
    case "user.disable": return done("turned off access for", person);
    case "user.enable": return done("turned on access for", person);
    case "user.remove": {
      const t = str(a.detail.transferTo);
      const u = users.find((x) => x.id === t);
      const name = t === meId ? "you" : u ? u.name || u.email : "another person";
      return done("removed", person, `, moving their links to ${name}`);
    }
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
