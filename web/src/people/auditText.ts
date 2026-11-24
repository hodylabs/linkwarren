import { providerName, type AuditItem } from "../api";
import { plural } from "../copy";
import { PERMS, PERM_TEXT, type Perm } from "../perms";

export type AuditText = { who: string; via: string | null; text: string; code: string | null; suffix: string };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Known permission keys in a detail array as their labels; anything else is dropped. */
const labels = (v: unknown): string[] => (Array.isArray(v) ? PERMS.filter((p: Perm) => v.includes(p)).map((p) => PERM_TEXT[p].label) : []);

/** A provider mid-sentence: "Google", "GitHub", and OIDC (or an unknown id) as "single sign-on". */
const ssoName = (p: unknown): string => (p === "oidc" ? "single sign-on" : providerName(p) ?? "single sign-on");
const SSO_FIELDS: Record<string, string> = { enabled: "on or off", clientId: "client ID", clientSecret: "client secret", issuer: "issuer", label: "button label" };
/** ": auto-join as Member, single sign-on enforced" from an email_domain.set detail; only what the detail says. */
function emailDomainSuffix(d: Record<string, unknown>): string {
  const parts = [
    ...(str(d.joinRoleName) ?? str(d.joinRoleId) ? [`auto-join as ${str(d.joinRoleName) ?? str(d.joinRoleId)}`] : d.joinRoleId === null ? ["no auto-join"] : []),
    ...(d.enforceSso === true ? ["single sign-on enforced"] : d.enforceSso === false ? ["single sign-on not enforced"] : []),
  ];
  return parts.length ? `: ${parts.join(", ")}` : "";
}

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
    case "qr_label.create": return done("added the QR print", str(a.detail.label) ?? a.targetId, ` to ${link}`);
    case "qr_label.rename": return done("renamed the QR print", str(a.detail.label) ?? a.targetId, ` on ${link}`);
    case "qr_label.delete": return done("removed the QR print", str(a.detail.label) ?? a.targetId, ` from ${link}`);
    case "share.create":
    case "share.revoke": {
      const what = a.targetType === "domain" ? domains.find((d) => d.id === a.targetId)?.host ?? a.targetId : link;
      return done(a.action === "share.create" ? "made a share page for" : "turned off a share page for", what);
    }
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
      const custom = str(a.detail.roleId) && a.detail.roleId !== "member" && str(a.detail.roleName);
      return done("invited", person, a.detail.role === "owner" ? " as an owner"
        : `${custom ? ` as ${custom}` : ""} with access to ${hosts.length ? hosts.join(", ") : "the main domain"}`);
    }
    case "user.invite_resend": return done("re-sent the invite to", person);
    case "user.revoke": return done("revoked the invite for", person);
    case "user.role": {
      const moved = Array.isArray(a.detail.movedDomains) ? a.detail.movedDomains.filter((h): h is string => typeof h === "string") : [];
      const took = moved.length ? ` and took over ${moved.join(", ")}` : "";
      // S8 R14 rows carry both role names and ids.
      if (str(a.detail.toId) && str(a.detail.from) && str(a.detail.to)) return done("changed", person, ` from ${str(a.detail.from)} to ${str(a.detail.to)}${took}`);
      // toId since roles (S8 R14); older rows carry only to = "owner" | "member".
      const to = str(a.detail.toId) || str(a.detail.to);
      const what = to === "owner" ? " an owner" : to === "member" || !str(a.detail.to) ? " a member" : ` ${str(a.detail.to)}`;
      return done("made", person, `${what}${took}`);
    }
    case "role.create": return done("created the role", str(a.detail.name));
    case "role.update": {
      const add = labels(a.detail.added), rem = labels(a.detail.removed), from = str(a.detail.from);
      const parts = [...(add.length ? [`added ${add.join(", ")}`] : []), ...(rem.length ? [`removed ${rem.join(", ")}`] : [])];
      return done("changed the role", str(a.detail.name), `${parts.length ? `: ${parts.join(", ")}` : ""}${from ? `, renamed from ${from}` : ""}`);
    }
    case "role.delete": {
      const n = num(a.detail.people), to = str(a.detail.movedTo);
      return done("deleted the role", str(a.detail.name), n && to ? ` and moved ${plural(n, "person", "people")} to ${to}` : "");
    }
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
    // S14 (R12): single sign-on. Field names are mapped to words; unknown ones are dropped, values are never in the detail.
    case "signin.sso": {
      const p = ssoName(a.detail.provider);
      return done(a.detail.joined === true ? `joined by signing in with ${p}` : `signed in with ${p}`);
    }
    case "sso.settings": {
      const fields = Array.isArray(a.detail.fields) ? a.detail.fields.filter((f): f is string => typeof f === "string" && Object.hasOwn(SSO_FIELDS, f)).map((f) => SSO_FIELDS[f]!) : [];
      return done("changed the sign-in settings for", ssoName(a.detail.provider), fields.length ? `: ${fields.join(", ")}` : "");
    }
    case "email_domain.set": return done("set the email domain", str(a.detail.domain) ?? a.targetId, emailDomainSuffix(a.detail));
    case "email_domain.delete": return done("removed the email domain", str(a.detail.domain) ?? a.targetId);
    case "identity.unlink": return done(`unlinked a ${ssoName(a.detail.provider)} sign-in`);
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
