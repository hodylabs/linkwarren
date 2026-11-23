import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, type ConnectionItem, type KeyItem, type McpState } from "../api";
import { errorText } from "../copy";
import { isTypingTarget, useHotkeys, type Bindings } from "../keys";
import { navigate, useRoute } from "../router";
import { initials } from "../shell/Rail";
import { BackBar, useDetailView } from "../shell/narrow";
import { Confirm } from "../shell/Sheet";
import { Chip, CloseButton, PrimaryButton, ScreenHeader, Switch, Tag } from "../shell/ui";
import { can } from "../perms";
import { useApp } from "../state";
import { clock, shortDate } from "../time";
import { CLIENTS, HOWTO, type Client } from "./howto";
import { withBase } from "../base";

/** API & agents screen hotkeys and their text on the shortcuts sheet. */
export const AGENTS_KEYS = {
  n: "New API key",
  j: "Next agent or key",
  k: "Previous agent or key",
  c: "Copy the agent address",
  escape: "Clear the selection",
} as const;
/** Detail panel hotkeys (connection or key). */
export const AGENT_DETAIL_KEYS = { "shift+d": "Disconnect the selected agent, or revoke the selected key" } as const;

const SIX_WEEKS = 42 * 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");
const longDate = (s: number) => new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const used = (s: number | null) => (s === null ? "never" : clock(s));
const access = (write: boolean) => (write ? <Tag tone="wait">Read and write</Tag> : <Tag tone="ok">Read only</Tag>);
const expired = (k: KeyItem) => k.expiresAt <= nowSec();
const unused = (k: KeyItem) => nowSec() - k.createdAt > SIX_WEEKS && (k.lastUsedAt === null || nowSec() - k.lastUsedAt > SIX_WEEKS);

/** "Read links" / "Create links" / "Create and delete links", plus where: one host, a count, or nothing for all domains. */
export function canText(k: KeyItem, hosts: Map<string, string>): string {
  const what = k.del ? "Create and delete links" : k.write ? "Create links" : "Read links";
  const n = k.domainIds.length;
  if (n === 0) return what;
  return n === 1 ? `${what} on ${hosts.get(k.domainIds[0]!) ?? "1 domain"}` : `${what} on ${n} domains`;
}

type Person = { label: string; name: string | null; email: string; own: boolean };

const Who = ({ p }: { p: Person }) => (
  <span className={p.own ? "who me" : "who"}>
    <span className="avatar" aria-hidden="true">{initials(p.name, p.email)}</span>
    <span>{p.label}</span>
  </span>
);

type Call = { at: number; tool: string; status: string };
type DetailProps<T> = { item: T; person: Person; onModal(open: boolean): void; onClose(): void; onGone(): void };

function ConnDetail({ item: c, person, onModal, onClose, onGone, onSaved }: DetailProps<ConnectionItem> & { onSaved(c: ConnectionItem): void }) {
  const app = useApp();
  const [draft, setDraft] = useState({ write: c.write, del: c.del });
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [callsError, setCallsError] = useState(false);
  const busy = useRef(false);
  const path = `/api/agents/connections/${encodeURIComponent(c.id)}`;
  const changed = draft.write !== c.write || draft.del !== c.del;
  // The audit log names the person, so the hint does too (the mockup: "Dana R. via Claude").
  const auditName = person.name || person.email;
  // R6: on someone else's connection the owner may only lower access, so a switch that is off is not offered (the server 403 is the backstop).
  const noRaise = `Only ${person.label} can give it more access.`;
  const lockWrite = !person.own && !c.write;
  const lockDel = !person.own && !c.del;

  useEffect(() => onModal(confirm), [confirm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onModal(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ac = new AbortController();
    api<{ items: Call[] }>("GET", `${path}/calls`, undefined, ac.signal).then(
      (r) => setCalls(r.items),
      () => void (!ac.signal.aborted && setCallsError(true)),
    );
    return () => ac.abort();
  }, [path]);

  const run = async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await fn();
    } catch (e) {
      setConfirm(false);
      setError(errorText(code(e))); // the switches keep what was asked for
    } finally {
      busy.current = false;
    }
  };
  const save = () => run(async () => {
    if (!changed) return;
    const saved = await api<ConnectionItem>("PATCH", path, draft);
    onSaved({ ...c, write: saved.write, del: saved.del });
    app.announce("Access changed");
  });
  const disconnect = () => run(async () => {
    await api("DELETE", path);
    setConfirm(false);
    app.announce(`Disconnected ${c.clientName}`);
    onGone();
  });

  useHotkeys({ "shift+d": () => setConfirm(true) } satisfies Bindings<typeof AGENT_DETAIL_KEYS>, app.overlay === null && !confirm);

  return (
    <>
      <aside className="detail" aria-label="Selected agent">
        <div className="d-head">
          <CloseButton label="Close agent details" onClick={onClose} />
          <div className="title">{`${c.clientName}, for ${person.label}`}</div>
          <div className="row">
            {access(c.write)}
            <span className="muted">Connected {shortDate(c.createdAt)}</span>
          </div>
        </div>
        <div className="sect">
          <h3>What it can do</h3>
          {/* R10: reading is part of being connected, so it is not a switch; removing it means Disconnect. */}
          <div className="toggle">
            <div>
              Read links, domains and clicks<small>{person.own ? "On the domains you can use" : `On the domains ${person.label} can use`}</small>
            </div>
            <span className="muted">Always on</span>
          </div>
          <div className="toggle">
            <div>
              Create and edit links<small>{lockWrite ? noRaise : `Shown in the audit log as ${auditName} via ${c.clientName}`}</small>
            </div>
            <Switch checked={draft.write} disabled={lockWrite} onChange={(write) => setDraft((d) => ({ write, del: write && d.del }))} label="Create and edit links" />
          </div>
          <div className="toggle">
            <div>
              Delete links<small>{lockDel ? noRaise : "Off by default for agents"}</small>
            </div>
            <Switch checked={draft.del} disabled={lockDel} onChange={(del) => setDraft((d) => ({ write: d.write || del, del }))} label="Delete links" />
          </div>
        </div>
        <div className="sect">
          <h3>Recent calls</h3>
          {callsError && <p className="err">Could not load the recent calls.</p>}
          {calls?.length === 0 && <p className="muted">No calls yet.</p>}
        </div>
        {calls && calls.length > 0 && (
          <ul className="log">
            {calls.map((x, i) => (
              <li key={i}>
                <time dateTime={new Date(x.at * 1000).toISOString()}>{clock(x.at)}</time>
                <div>
                  <code>{x.tool}</code>
                  {x.status !== "ok" && ` ${x.status}`}
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="err pad" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn" disabled={!changed} onClick={() => void save()}>
            Change access
          </button>
          <button type="button" className="btn bad" onClick={() => setConfirm(true)} aria-keyshortcuts="Shift+D">
            Disconnect <kbd>Shift D</kbd>
          </button>
        </div>
      </aside>
      {confirm && (
        <Confirm title={`Disconnect ${c.clientName}`} text={`Disconnect ${c.clientName}? It stops working at once.`} ok="Disconnect"
          onOk={() => void disconnect()} onCancel={() => setConfirm(false)} />
      )}
    </>
  );
}

function KeyDetail({ item: k, person, hosts, onModal, onClose, onGone }: DetailProps<KeyItem> & { hosts: Map<string, string> }) {
  const app = useApp();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const busy = useRef(false);
  useEffect(() => onModal(confirm), [confirm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onModal(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const revoke = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await api("DELETE", `/api/keys/${encodeURIComponent(k.id)}`);
      setConfirm(false);
      app.announce(`Revoked ${k.name}`);
      onGone();
    } catch (e) {
      setConfirm(false);
      setError(errorText(code(e)));
    } finally {
      busy.current = false;
    }
  };
  useHotkeys({ "shift+d": () => setConfirm(true) } satisfies Bindings<typeof AGENT_DETAIL_KEYS>, app.overlay === null && !confirm);

  const doms = k.domainIds.length ? k.domainIds.map((id) => hosts.get(id) ?? id).join(", ") : person.own ? "All domains you can use" : `All domains ${person.label} can use`;
  return (
    <>
      <aside className="detail" aria-label="Selected API key">
        <div className="d-head">
          <CloseButton label="Close key details" onClick={onClose} />
          <div className="title mono">{k.name}</div>
          <div className="row">
            {expired(k) ? <Tag tone="bad">Expired</Tag> : access(k.write)}
            <span className="muted">For {person.label}</span>
          </div>
        </div>
        <div className="sect">
          <dl className="facts">
            <dt>Starts with</dt>
            <dd className="mono">{k.prefix}</dd>
            <dt>Can</dt>
            <dd>{canText(k, hosts)}</dd>
            <dt>Domains</dt>
            <dd>{doms}</dd>
            <dt>{expired(k) ? "Expired" : "Expires"}</dt>
            <dd>{longDate(k.expiresAt)}</dd>
            <dt>Last used</dt>
            <dd>{used(k.lastUsedAt)}</dd>
          </dl>
        </div>
        {error && (
          <p className="err pad" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn bad" onClick={() => setConfirm(true)} aria-keyshortcuts="Shift+D">
            Revoke <kbd>Shift D</kbd>
          </button>
        </div>
        <div className="foot">
          <span>Created {shortDate(k.createdAt)}</span>
        </div>
      </aside>
      {confirm && (
        <Confirm title={`Revoke ${k.name}`} text={`Revoke ${k.name}? Anything using it stops working at once.`} ok="Revoke"
          onOk={() => void revoke()} onCancel={() => setConfirm(false)} />
      )}
    </>
  );
}

export function AgentsScreen() {
  const app = useApp();
  const { me, users, domains, overlay } = app;
  const settingsOk = can(me, "settings"); // the MCP on/off switch is an instance setting (S8 R5)
  const agentsOk = can(me, "agents");
  const { query } = useRoute();
  const sel = query.get("sel");
  const { open, show, back } = useDetailView("/agents");
  const [conns, setConns] = useState<ConnectionItem[] | null>(null);
  const [keys, setKeys] = useState<KeyItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mcpState, setMcpState] = useState<McpState | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const mcp = mcpState === null ? null : mcpState.on ? "on" : "off";
  const [client, setClient] = useState<Client>("claude");
  const [modal, setModal] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const focusRow = useRef(false);
  const url = `https://${location.host}${withBase("/mcp")}`;
  const hosts = new Map(domains.map((d) => [d.id, d.host]));

  // Owners and people managers see everyone's they may manage; others get their own (the server enforces it either way).
  const all = can(me, "people.manage") ? "?all=1" : "";
  const gen = useRef(0);
  const reading = useRef(false);
  const load = useCallback(() => {
    const g = ++gen.current;
    reading.current = true;
    setError(null);
    Promise.all([api<{ items: ConnectionItem[] }>("GET", `/api/agents/connections${all}`), api<{ items: KeyItem[] }>("GET", `/api/keys${all}`)])
      .then(
        ([c, k]) => {
          if (g !== gen.current) return;
          setConns(c.items);
          setKeys(k.items);
        },
        (e: unknown) => void (g === gen.current && setError(errorText(code(e)))),
      )
      .finally(() => void (g === gen.current && (reading.current = false)));
  }, [all]);
  // A read still in flight was taken before this change: drop it and read again.
  const changed = () => void (reading.current && load());
  useEffect(load, [load]);
  // A key made in the New API key sheet shows up once the sheet closes.
  const lastOverlay = useRef(overlay?.kind);
  useEffect(() => {
    if (lastOverlay.current === "newKey" && overlay === null) load();
    lastOverlay.current = overlay?.kind;
  }, [overlay, load]);

  const loadMcp = useCallback(() => api<McpState>("GET", "/api/agents/mcp").then(setMcpState, (e: unknown) => setMcpError(errorText(code(e)))), []);
  useEffect(() => void loadMcp(), [loadMcp]);
  // One update at a time: a press while one is out is ignored (not disabled, so keyboard focus stays on the switch).
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const setMcpOn = (on: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMcpError(null);
    const done = () => { savingRef.current = false; setSaving(false); };
    api<McpState>("PUT", "/api/agents/mcp", { on }).then(
      (st) => {
        setMcpState(st);
        app.announce(st.on ? "Agent connections on" : "Agent connections off");
      },
      (e: unknown) => {
        setMcpError(errorText(code(e)));
        return loadMcp();
      },
    ).finally(done);
  };

  const person = (userId: string, email: string | null): Person => {
    if (userId === me.id) return { label: "You", name: me.name, email: me.email, own: true };
    const u = users?.find((x) => x.id === userId);
    const mail = u?.email ?? email ?? "";
    return { label: u?.name || mail || "Someone", name: u?.name ?? null, email: mail, own: false };
  };

  // R7: a key (or connection) whose person's role has no `keys` (`agents`) is refused, not revoked; it stays listed to revoke.
  const paused = (row: { userId: string }, p: "keys" | "agents") => {
    const who = row.userId === me.id ? me : users?.find((u) => u.id === row.userId);
    return who !== undefined && !can(who, p);
  };
  const ids = [...(conns ?? []).map((c) => c.id), ...(keys ?? []).map((k) => k.id)];
  const at = sel ? ids.indexOf(sel) : -1;
  const selConn = conns?.find((c) => c.id === sel) ?? null;
  const selKey = keys?.find((k) => k.id === sel) ?? null;

  const select = (id: string | null, focus = false) => {
    focusRow.current = focus;
    const p = new URLSearchParams(location.search);
    if (id) p.set("sel", id);
    else {
      p.delete("sel");
      p.delete("view"); // nothing selected: no detail view either
    }
    const s = p.toString();
    navigate(`/agents${s ? `?${s}` : ""}`, { replace: true });
  };
  const closeDetail = () => {
    if (open) return back();
    if (sel) rowRefs.current.get(sel)?.focus();
    select(null);
  };
  useEffect(() => {
    if (focusRow.current && sel) rowRefs.current.get(sel)?.focus();
    focusRow.current = false;
  }, [sel, conns, keys]);
  const move = (step: 1 | -1) => {
    if (ids.length === 0) return;
    const to = at < 0 ? ids[step === 1 ? 0 : ids.length - 1] : ids[at + step];
    if (to) select(to, true);
  };
  // After Disconnect or Revoke the confirm's opener is gone: focus the next row, else the previous, else the list heading.
  const focusAfter = useRef<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const gone = () => {
    focusAfter.current = ids[at + 1] ?? ids[at - 1] ?? "";
    setConns((l) => l && l.filter((c) => c.id !== sel));
    setKeys((l) => l && l.filter((k) => k.id !== sel));
    select(null);
    changed();
  };
  useEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    focusAfter.current = null;
    (rowRefs.current.get(id) ?? headRef.current)?.focus();
  }, [conns, keys]);

  const copy = () => {
    if (mcp !== "on" || !agentsOk) return;
    navigator.clipboard.writeText(url).then(() => app.announce("Copied"), () => app.announce("Could not copy. Select the address and copy it."));
  };

  useHotkeys(
    {
      n: () => app.open({ kind: "newKey" }),
      j: () => move(1),
      k: () => move(-1),
      c: (e) => void (!e.shiftKey && copy()), // Shift+C is not Copy
      escape: (e) => {
        if (!isTypingTarget(e.target) && sel) closeDetail();
      },
    } satisfies Bindings<typeof AGENTS_KEYS>,
    overlay === null && !modal,
  );

  // Left and Right move between the client chips and pick the one they land on; Enter and Space work natively.
  const chipKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = (CLIENTS.findIndex((c) => c.value === client) + step + CLIENTS.length) % CLIENTS.length;
    setClient(CLIENTS[i]!.value);
    e.currentTarget.querySelectorAll<HTMLButtonElement>("button")[i]?.focus();
  };

  const row = (id: string) => ({
    ref: (el: HTMLTableRowElement | null) => void (el ? rowRefs.current.set(id, el) : rowRefs.current.delete(id)),
    "aria-selected": id === sel,
    tabIndex: id === sel || (at < 0 && id === ids[0]) ? 0 : -1,
    onClick: () => show(id) || select(id),
    onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => e.key === "Enter" && e.target === e.currentTarget && (e.preventDefault(), show(id) || select(id)),
  });

  const selected = selConn ?? selKey;
  return (
    <>
      <ScreenHeader title="API & agents" text="connect Claude, ChatGPT, Claude Code, Codex, Gemini or your own scripts">
        {can(me, "keys") && <PrimaryButton label="New API key" shortcut="N" onClick={() => app.open({ kind: "newKey" })} />}
      </ScreenHeader>
      <div className={`body agents${open ? " open" : ""}${selected ? "" : " solo"}`}>
        <section className="list" aria-label="Agents and API keys">
          <div className="connect">
            <div>
              <h3>Connect an agent</h3>
              {agentsOk ? (
                <p>
                  Add this address as a connector in Claude, ChatGPT, Claude Code, Codex or Gemini. You sign in, choose read only or read and write, and the agent acts as you: it can
                  never see or change more than you can.
                </p>
              ) : (
                <p>Your role does not allow AI agents.</p>
              )}
            </div>
            {mcpState && (
              <div className="toggle">
                <div id="mcp-hint">
                  Agent connections (MCP)
                  <small>
                    {mcpState.locked
                      ? "Locked off by the deploy config (MCP_ENABLED=0)."
                      : mcpState.on
                        ? "Turning this off does not disconnect agents. Their calls are refused until you turn it back on."
                        : settingsOk
                          ? "Agents cannot connect until you turn this on."
                          : "Agent connections are turned off on this instance. Ask the owner."}
                  </small>
                </div>
                {settingsOk ? (
                  <fieldset className="plain" disabled={mcpState.locked} aria-busy={saving}>
                    <Switch checked={mcpState.on} onChange={setMcpOn} label="Agent connections (MCP)" describedBy="mcp-hint" disabled={mcpState.locked} />
                  </fieldset>
                ) : (
                  <Tag tone={mcpState.on ? "ok" : "off"}>{mcpState.on ? "On" : "Off"}</Tag>
                )}
              </div>
            )}
            {mcpError && (
              <p className="err" role="alert">
                {mcpError}
              </p>
            )}
            {mcp === "on" && agentsOk && (
              <>
                <div className="mcp">
                  <span className="mono">{url}</span>
                  <button type="button" className="btn ghost" onClick={copy} aria-keyshortcuts="C">
                    Copy <kbd>C</kbd>
                  </button>
                </div>
                <div className="howto">
                  <div className="chips" role="group" aria-label="Agent" onKeyDown={chipKey}>
                    {CLIENTS.map((c) => (
                      <Chip key={c.value} pressed={client === c.value} onClick={() => setClient(c.value)}>
                        {c.label}
                      </Chip>
                    ))}
                  </div>
                  <span className="mono muted">{HOWTO[client](url)}</span>
                </div>
              </>
            )}
          </div>
          {error && (
            <p className="err pad" role="alert">
              {error}
            </p>
          )}
          <h2 className="sub-h" ref={headRef} tabIndex={-1}>Connected agents</h2>
          {conns === null && !error && <p className="muted pad">Loading agents</p>}
          {conns?.length === 0 && <p className="muted pad">No agents connected yet.</p>}
          {conns && conns.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>For</th>
                  <th>Access</th>
                  <th>Connected</th>
                  <th>Last used</th>
                  <th className="num">Calls, 7 days</th>
                </tr>
              </thead>
              <tbody>
                {conns.map((c) => (
                  <tr key={c.id} {...row(c.id)}>
                    <td>{c.clientName}</td>
                    <td><Who p={person(c.userId, c.userEmail)} /></td>
                    <td>{paused(c, "agents") && <><Tag tone="off">Paused by role</Tag> </>}{access(c.write)}</td>
                    <td data-label="Connected">{shortDate(c.createdAt)}</td>
                    <td data-label="Last used">{used(c.lastUsedAt)}</td>
                    <td className="num" data-label="Calls, 7 days">{c.calls7d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2 className="sub-h">API keys</h2>
          {keys === null && !error && <p className="muted pad">Loading keys</p>}
          {keys?.length === 0 && <p className="muted pad">No API keys yet.</p>}
          {keys && keys.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>For</th>
                  <th>Can</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} {...row(k.id)}>
                    <td className="mono">{k.name}</td>
                    <td><Who p={person(k.userId, k.userEmail)} /></td>
                    <td>{canText(k, hosts)}</td>
                    <td data-label="Created">{shortDate(k.createdAt)}</td>
                    <td data-label="Last used">{used(k.lastUsedAt)}</td>
                    {/* Expired keys still count toward the 20-key cap until revoked, so they stay listed. */}
                    <td data-label="Expires">
                      {paused(k, "keys") && <><Tag tone="off">Paused by role</Tag> </>}
                      {expired(k) ? <Tag tone="bad">Expired</Tag> : unused(k) ? <Tag tone="bad">Unused 6 weeks</Tag> : longDate(k.expiresAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {open && <BackBar label="All agents and keys" onBack={back} />}
        {selConn && (
          <ConnDetail key={selConn.id} item={selConn} person={person(selConn.userId, selConn.userEmail)} onModal={setModal} onClose={closeDetail} onGone={gone}
            onSaved={(c) => {
              setConns((l) => l && l.map((x) => (x.id === c.id ? c : x)));
              changed();
            }} />
        )}
        {selKey && <KeyDetail key={selKey.id} item={selKey} person={person(selKey.userId, selKey.userEmail)} hosts={hosts} onModal={setModal} onClose={closeDetail} onGone={gone} />}
      </div>
    </>
  );
}
