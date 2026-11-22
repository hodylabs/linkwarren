import { api } from "../api";

/** in_use: the zone's fallback origin is someone else's, so setup refuses and outside domains are not ready. */
export type FallbackOrigin = "active" | "pending" | "missing" | "in_use" | null;
export type CloudflareSettings = {
  configured: boolean;
  outsideReady: boolean;
  accountName: string | null;
  cnameTarget: string | null;
  fallbackOrigin: FallbackOrigin;
  hostnames: { used: number; limit: number } | null;
  attachedCount: number;
  controlsEnabled: boolean;
};
export type PermState = "ok" | "missing" | "unknown";
export type PermKey = "zone_read" | "dns_edit" | "routes_edit" | "ssl_edit" | "config_rules_edit" | "waf_edit";
export type CheckResult = { token: "active" | "invalid"; accountName: string | null; permissions: { key: PermKey; state: PermState }[] };
export type ResyncResult = { ok: number; failed: { host: string; error: string }[]; next: string | null };
export type ControlsPatch = { securityLevel?: string | null; rateLimit?: number | null };

/** Copied from the server's permission list (src/cf/perms.ts); the UI never imports server code. */
export const PERMISSIONS: readonly { key: PermKey; label: string; why: string }[] = [
  { key: "zone_read", label: "Zone: Read", why: "See which domains are in this account" },
  { key: "dns_edit", label: "DNS: Edit", why: "Point your domains at linkwarren" },
  { key: "routes_edit", label: "Workers Routes: Edit", why: "Send each domain's traffic to the app" },
  { key: "ssl_edit", label: "SSL and Certificates: Edit", why: "Add outside domains with a CNAME (Cloudflare for SaaS)" },
  { key: "config_rules_edit", label: "Config Rules: Edit", why: "Security level per domain" },
  { key: "waf_edit", label: "Zone WAF: Edit", why: "Rate limit per domain" },
];

export const getCloudflare = (signal?: AbortSignal) => api<CloudflareSettings>("GET", "/api/settings/cloudflare", undefined, signal);
/** Never sends a token: the candidate-token check belongs to the first-run setup. */
export const checkCloudflare = () => api<CheckResult>("POST", "/api/settings/cloudflare/check", {});
export const setControls = (controlsEnabled: boolean) => api<{ controlsEnabled: boolean }>("PATCH", "/api/settings/cloudflare", { controlsEnabled });
export const setupOutside = () => api<{ target: string; fallbackOrigin: "active" | "pending" }>("POST", "/api/settings/cloudflare/setup", {});
export const resyncBatch = (after: string | undefined, signal: AbortSignal) =>
  api<ResyncResult>("POST", "/api/settings/cloudflare/resync", after === undefined ? {} : { after }, signal);
export const patchDomainCf = (id: string, body: ControlsPatch) =>
  api<{ securityLevel: string | null; rateLimit: number | null }>("PATCH", `/api/domains/${encodeURIComponent(id)}/cloudflare`, body);

/** GET /api/instance (any signed-in user): what the rail, the document title and the link form need. */
export type InstanceInfo = {
  name: string | null; logoVersion: number | null; configured: boolean; dashboardHost: string; mainDomainId: string | null;
  linkDefaults: { redirectCode: 301 | 302; passQuery: boolean };
};
export type SecretSource = "secret" | "dashboard" | "missing";
export type SecretStatus = { pasteAvailable: boolean; cf: SecretSource; resend: SecretSource };
/** GET and PATCH /api/settings (owner). Never carries a secret value, only where each one comes from. */
export type SettingsBody = {
  name: string | null; mainDomainId: string | null; dashboardHost: string; authMode: "app" | "access"; teamDomain?: string;
  emailFrom: string | null; emailConfigured: boolean; secrets: SecretStatus; linkRedirectCode: 301 | 302; linkPassQuery: boolean;
  retention: { auditDays: number; clickDetailDays: number };
};
export type SettingsPatch = Partial<Pick<SettingsBody, "name" | "mainDomainId" | "linkRedirectCode" | "linkPassQuery">>;

/** The logo image URL; the version busts the browser cache after a replace. */
export const logoUrl = (v: number | null) => (v === null ? "/linkwarren-mark.svg" : `/api/instance/logo?v=${encodeURIComponent(v)}`);

export const getInstance = (signal?: AbortSignal) => api<InstanceInfo>("GET", "/api/instance", undefined, signal);
export const getSettings = (signal?: AbortSignal) => api<SettingsBody>("GET", "/api/settings", undefined, signal);
export const patchSettings = (patch: SettingsPatch) => api<SettingsBody>("PATCH", "/api/settings", patch);
export const putLogo = (logo: { type: string; data: string }) => api<{ logoVersion: number }>("PUT", "/api/settings/logo", logo);
export const deleteLogo = () => api<{ logoVersion: null }>("DELETE", "/api/settings/logo");
export const putSecret = (name: "cf" | "resend", value: string) => api<SecretStatus>("PUT", `/api/settings/secrets/${name}`, { value });
export const deleteSecret = (name: "cf" | "resend") => api<SecretStatus>("DELETE", `/api/settings/secrets/${name}`);
export const sendTestEmail = () => api<{ ok: true }>("POST", "/api/settings/email/test", {});
