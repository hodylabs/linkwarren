import { describe, expect, it } from "vitest";
import type { Domain, Link, Me, UserItem } from "../api";
import { fromLocalInput, shortDate, toLocalInput } from "../time";
import { creatorLabel, linkState, linksQuery, shortUrl, sparkPoints } from "./linkView";

const NOW = 1_800_000_000;
const link = (o: Partial<Link> = {}): Link => ({
  id: "l1", domainId: "d1", slug: "spring", slugKey: "spring", url: "https://example.com/a", redirectCode: 302,
  startsAt: null, expiresAt: null, passQuery: true, hasPassword: false, routes: [], createdBy: "u1", updatedBy: "u1", createdAt: 1, updatedAt: 1, ...o,
});
const dom = (status: Domain["status"]): Domain => ({
  id: "d1", host: "go.test", type: "main", status, ownerId: "uo", bareRedirect: null, notfoundRedirect: null,
  caseSensitive: false, noindex: true, reservedExtra: [], createdAt: 1, linkCount: 0, isMember: false,
});

describe("linkState", () => {
  it("covers every branch", () => {
    expect(linkState(link(), dom("pending"), NOW)).toEqual({ label: "Not active yet", tone: "wait" });
    expect(linkState(link(), dom("disabled"), NOW)).toEqual({ label: "Domain disabled", tone: "off" });
    expect(linkState(link({ startsAt: NOW + 86400 }), dom("active"), NOW)).toEqual({ label: `Starts ${shortDate(NOW + 86400)}`, tone: "wait" });
    expect(linkState(link({ expiresAt: NOW }), dom("active"), NOW)).toEqual({ label: "Expired", tone: "off" });
    expect(linkState(link({ startsAt: NOW - 5, expiresAt: NOW + 5 }), dom("active"), NOW)).toEqual({ label: "Active", tone: "ok" });
    expect(linkState(link(), undefined, NOW).label).toBe("Active");
  });
});

describe("shortUrl and creatorLabel", () => {
  const owner: Me = { id: "uo", email: "o@example.com", name: null, role: "owner" };
  const member: Me = { ...owner, id: "um", role: "member" };
  const users = [{ id: "u1", email: "dana@example.com", name: "Dana R." }, { id: "u2", email: "x@example.com", name: null }] as UserItem[];
  it("builds the url", () => expect(shortUrl("go.test", "spring")).toBe("https://go.test/spring"));
  it("You, names for the owner, Teammate for members", () => {
    expect(creatorLabel("um", member, null)).toBe("You");
    expect(creatorLabel("u1", owner, users)).toBe("Dana R.");
    expect(creatorLabel("u2", owner, users)).toBe("x@example.com");
    expect(creatorLabel("u1", member, null)).toBe("Teammate");
  });
});

describe("linksQuery", () => {
  const base = { domain: null, q: "", status: "all", mine: false, cursor: null } as const;
  it("omits empty values and never sends cursor=", () => {
    expect(linksQuery(base)).toBe("");
    expect(linksQuery({ ...base, cursor: "" })).not.toContain("cursor");
  });
  it("sends the filters", () => {
    expect(linksQuery({ ...base, domain: "d1", q: "a b", status: "expired", mine: true, cursor: "5.x" })).toBe("domain=d1&q=a+b&status=expired&mine=1&cursor=5.x");
  });
  it("keeps q to 48 characters", () => expect(new URLSearchParams(linksQuery({ ...base, q: "x".repeat(60) })).get("q")).toHaveLength(48));
});

describe("local datetime", () => {
  it("empty is null and values round-trip", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(toLocalInput(null)).toBe("");
    const t = 1_790_000_040;
    expect(fromLocalInput(toLocalInput(t))).toBe(t);
    expect(toLocalInput(t)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  });
});

describe("sparkPoints", () => {
  it("scales to the 72x20 box, last point at x 72", () => {
    expect(sparkPoints([0, 0, 0])).toBe("0,18 36,18 72,18");
    expect(sparkPoints([1, 2])).toBe("0,10 72,2");
    expect(sparkPoints([1, 2, 3], 5)).toBe("0,12.7 18,7.3 36,2");
    // live off: 5 known days of 7 end at x 48, leaving the last two slots for the dashed segment
    expect(sparkPoints([0, 1, 2, 3, 4], 7)).toBe("0,18 12,14 24,10 36,6 48,2");
  });
});
