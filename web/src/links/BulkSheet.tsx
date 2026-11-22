import { useMemo, useRef, useState } from "react";
import type { BulkOp, Link } from "../api";
import { errorText, plural } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { Sheet } from "../shell/Sheet";
import { Seg } from "../shell/ui";
import { useApp } from "../state";
import { fromLocalInput } from "../time";
import type { BulkAction } from "./BulkBar";
import { runBulk } from "./bulk";
import { passwordProblem } from "./rules";

export type BulkMode = Exclude<BulkAction, "copy" | "export">;
export type BulkRun = Awaited<ReturnType<typeof runBulk>>;

/** Bulk sheet hotkeys and their text on the shortcuts sheet (Esc closes, from Sheet). */
export const BULK_SHEET_KEYS = { "mod+enter": "Run the action on the selected links" } as const;

const TITLE: Record<BulkMode, string> = { delete: "Delete links", schedule: "Schedule links", move: "Move links", redirect: "Redirect type", password: "Password" };
const RUN: Record<BulkMode, string> = { delete: "Delete", schedule: "Schedule", move: "Move", redirect: "Change", password: "Apply" };
const SHOWN_FAILURES = 50;

type Phase =
  | { k: "form" }
  | { k: "confirm"; op: BulkOp; text: string }
  | { k: "running"; done: number; total: number }
  | { k: "results"; op: BulkOp; ok: number; failed: [string, string][] };

/** One sheet per bulk action: the form, a confirm for anything that takes links offline or removes passwords, progress, results. */
export function BulkSheet({ mode, links, onRun, onClose }: { mode: BulkMode; links: Link[]; onRun(op: BulkOp, r: BulkRun): void; onClose(): void }) {
  const { me, domains } = useApp();
  const n = links.length;
  // Names of the links as they were when the sheet opened: a deleted or moved link still reads as what the person picked.
  const [names] = useState(() => new Map(links.map((l) => [l.id, `${domains.find((d) => d.id === l.domainId)?.host ?? ""}/${l.slug}`])));
  const [phase, setPhase] = useState<Phase>({ k: "form" });
  const ctl = useRef<AbortController | null>(null);

  const [starts, setStarts] = useState<"keep" | "set" | "none">("keep");
  const [startsAt, setStartsAt] = useState("");
  const [ends, setEnds] = useState<"keep" | "set" | "none" | "now">("keep");
  const [endsAt, setEndsAt] = useState("");
  const [code, setCode] = useState<"keep" | "302" | "301">("keep");
  const [pass, setPass] = useState<"keep" | "on" | "off">("keep");
  const [pwMode, setPwMode] = useState<"set" | "remove">("set");
  const [password, setPassword] = useState(""); // never logged or announced
  // Move: only active domains the person can use (D12); the old-address choice starts empty every time (R5).
  const targets = useMemo(
    () => domains.filter((d) => d.status === "active" && (me.role === "owner" || d.type === "main" || d.isMember || d.ownerId === me.id)),
    [domains, me],
  );
  const [target, setTarget] = useState(() => {
    const from = new Set(links.map((l) => l.domainId));
    return (targets.find((d) => !(from.size === 1 && from.has(d.id))) ?? targets[0])?.id ?? "";
  });
  const [oldAddress, setOldAddress] = useState<"forward" | "copy" | null>(null);
  const targetHost = targets.find((d) => d.id === target)?.host ?? "";

  const pwProblem = mode === "password" && pwMode === "set" ? passwordProblem(password) : null;

  /** The op to send, or the hint that says what is missing. */
  const build = (): { op: BulkOp } | { hint: string } => {
    if (mode === "delete") return { op: { action: "delete" } };
    if (mode === "schedule") {
      const s = starts === "set" ? fromLocalInput(startsAt) : null, x = ends === "set" ? fromLocalInput(endsAt) : null;
      if (starts === "keep" && ends === "keep") return { hint: "Change the start or the end" };
      if ((starts === "set" && s === null) || (ends === "set" && x === null)) return { hint: "Pick a date and time" };
      if (s !== null && x !== null && x <= s) return { hint: errorText("bad_window") };
      return {
        op: {
          action: "schedule",
          ...(starts !== "keep" ? { startsAt: s } : {}),
          ...(ends === "now" ? { endNow: true as const } : ends !== "keep" ? { expiresAt: x } : {}),
        },
      };
    }
    if (mode === "redirect") {
      if (code === "keep" && pass === "keep") return { hint: "Pick a redirect type or a query string setting" };
      return { op: { action: "redirect", ...(code !== "keep" ? { redirectCode: Number(code) as 301 | 302 } : {}), ...(pass !== "keep" ? { passQuery: pass === "on" } : {}) } };
    }
    if (mode === "password") {
      if (pwMode === "remove") return { op: { action: "password", password: null } };
      return pwProblem ? { hint: errorText(pwProblem) } : { op: { action: "password", password } };
    }
    if (!target) return { hint: "There is no other active domain to move to" };
    if (!oldAddress) return { hint: "Pick what happens to the old addresses" };
    return { op: { action: "move", domainId: target, oldAddress } };
  };
  const built = build();

  /** Text of the confirm step for an op that takes links offline or removes passwords, else null. */
  const risk = (op: BulkOp): string | null => {
    const now = Math.floor(Date.now() / 1000);
    if (op.action === "schedule" && (op.endNow || (op.expiresAt != null && op.expiresAt <= now) || (op.startsAt != null && op.startsAt > now)))
      return `This takes ${plural(n, "link")} offline. Visitors get each domain's not-found page until the schedule lets them through again.`;
    if (op.action === "password" && op.password === null) return `Remove the password from ${plural(n, "link")}? Anyone with one of these short links can open it again.`;
    return null;
  };

  const go = async (op: BulkOp, ids: string[]) => {
    const c = new AbortController();
    ctl.current = c;
    setPhase({ k: "running", done: 0, total: ids.length });
    const r = await runBulk(op, ids, { onProgress: (done, total) => setPhase({ k: "running", done, total }), signal: c.signal });
    ctl.current = null;
    onRun(op, r);
    setPhase({ k: "results", op, ok: r.ok.size, failed: [...r.failed] });
  };
  const submit = () => {
    if (phase.k !== "form" || !("op" in built)) return;
    const text = risk(built.op);
    if (text) setPhase({ k: "confirm", op: built.op, text });
    else void go(built.op, links.map((l) => l.id));
  };
  useHotkeys({ "mod+enter": submit } satisfies Bindings<typeof BULK_SHEET_KEYS>, phase.k === "form");

  // Esc while running cancels after the request in flight; the results then show what was done.
  const close = () => (phase.k === "running" ? ctl.current?.abort() : onClose());
  const reason = (op: BulkOp, code: string) => (code === "bad_window" && op.action === "schedule" && op.endNow ? "Starts later: clear its start first" : errorText(code));

  return (
    <Sheet label={TITLE[mode]} onClose={close}>
      <div className="sh-head">
        <h2>{TITLE[mode]}</h2>
      </div>
      <div className="sh-body">
        {phase.k === "form" && (
          <>
            {mode === "delete" && (
              <p>
                Delete {plural(n, "link")}? Visits go to each domain's not-found page and the slugs stay locked, so printed QR codes keep failing rather than being
                taken over.
              </p>
            )}
            {mode === "schedule" && (
              <>
                <div className="field">
                  <label>Starts</label>
                  <Seg wrap label="Starts" value={starts} onChange={setStarts} options={[{ value: "keep", label: "Keep" }, { value: "set", label: "Date and time" }, { value: "none", label: "No start" }]} />
                  {starts === "set" && <input className="input" type="datetime-local" aria-label="Start date and time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />}
                </div>
                <div className="field">
                  <label>Ends</label>
                  <Seg wrap label="Ends" value={ends} onChange={setEnds} options={[{ value: "keep", label: "Keep" }, { value: "set", label: "Date and time" }, { value: "none", label: "No end" }, { value: "now", label: "End now" }]} />
                  {ends === "set" && <input className="input" type="datetime-local" aria-label="End date and time" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />}
                  {ends === "now" && <p className="hint">End now switches the links off.</p>}
                </div>
              </>
            )}
            {mode === "redirect" && (
              <>
                <div className="field">
                  <label>Redirect</label>
                  <Seg label="Redirect" value={code} onChange={setCode} options={[{ value: "302", label: "302" }, { value: "301", label: "301" }, { value: "keep", label: "Keep" }]} />
                </div>
                <div className="field">
                  <label>Pass query string through</label>
                  <Seg label="Pass query string" value={pass} onChange={setPass} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }, { value: "keep", label: "Keep" }]} />
                </div>
                <p className="hint">Password links stay on 302.</p>
              </>
            )}
            {mode === "password" && (
              <>
                <Seg wrap label="Password" value={pwMode} onChange={setPwMode} options={[{ value: "set", label: "Set a password" }, { value: "remove", label: "Remove the password" }]} />
                {pwMode === "set" && (
                  <div className="field">
                    <label htmlFor="bk-pw">New password</label>
                    <input
                      id="bk-pw" className="input" type="password" value={password} autoComplete="new-password" spellCheck={false} autoCapitalize="off"
                      aria-invalid={(password !== "" && !!pwProblem) || undefined} aria-describedby={password !== "" && pwProblem ? "bk-pw-err" : undefined}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    {password !== "" && pwProblem && (
                      <p className="err" id="bk-pw-err" role="alert">
                        {errorText(pwProblem)}
                      </p>
                    )}
                  </div>
                )}
                <p className="hint">Each link gets its own hash, so setting one takes a moment per link.</p>
              </>
            )}
            {mode === "move" && (
              <>
                <div className="field">
                  <label>Move to</label>
                  {targets.length ? (
                    <Seg wrap label="Move to" value={target} onChange={setTarget} options={targets.map((d) => ({ value: d.id, label: d.host }))} />
                  ) : (
                    <p className="hint">There is no other active domain to move to.</p>
                  )}
                </div>
                <fieldset className="plain bk-old">
                  <legend>What happens to the old addresses?</legend>
                  <label>
                    <input type="radio" name="bk-old" checked={oldAddress === "forward"} onChange={() => setOldAddress("forward")} />
                    <span>
                      Keep them working
                      <small>Each old address forwards visitors to the new short link, so printed links and QR codes keep working.</small>
                    </span>
                  </label>
                  <label>
                    <input type="radio" name="bk-old" checked={oldAddress === "copy"} onChange={() => setOldAddress("copy")} />
                    <span>
                      Keep a copy on both domains
                      <small>The links stay where they are, and an independent copy with the same slug, destination and rules, password included, is made on {targetHost}.</small>
                    </span>
                  </label>
                </fieldset>
              </>
            )}
            {"hint" in built && mode !== "password" && <p className="hint">{built.hint}</p>}
            <div className="actions">
              <button type="button" className="btn primary" autoFocus={mode === "delete"} disabled={!("op" in built)} onClick={submit} aria-keyshortcuts={mode === "delete" ? "Enter" : "Control+Enter"}>
                {RUN[mode]} <span className="k">{mode === "delete" ? "Enter" : "Ctrl Enter"}</span>
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </>
        )}
        {phase.k === "confirm" && (
          <>
            <p>{phase.text}</p>
            <div className="actions">
              <button type="button" className="btn primary" autoFocus onClick={() => void go(phase.op, links.map((l) => l.id))}>
                {RUN[mode]} <span className="k">Enter</span>
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </>
        )}
        {phase.k === "running" && (
          <>
            <p role="status">
              Working, {phase.done} of {phase.total}
            </p>
            <progress className="bk-prog" value={phase.done} max={phase.total} aria-label="Progress" />
            <div className="actions">
              <button type="button" className="btn" onClick={() => ctl.current?.abort()}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </>
        )}
        {phase.k === "results" && (
          <>
            <p role="status">
              {phase.ok} changed, {phase.failed.length} not changed
            </p>
            {phase.failed.length > 0 && (
              <ul className="bk-list" aria-label="Not changed">
                {phase.failed.slice(0, SHOWN_FAILURES).map(([id, c]) => (
                  <li key={id}>
                    <span className="mchip">{names.get(id) ?? id}</span>
                    <span>{reason(phase.op, c)}</span>
                  </li>
                ))}
              </ul>
            )}
            {phase.failed.length > SHOWN_FAILURES && <p className="hint">and {phase.failed.length - SHOWN_FAILURES} more</p>}
            <div className="actions">
              {phase.failed.length > 0 && (
                <button type="button" className="btn primary" autoFocus onClick={() => void go(phase.op, phase.failed.map(([id]) => id))}>
                  Retry failed <span className="k">Enter</span>
                </button>
              )}
              <button type="button" className="btn" autoFocus={phase.failed.length === 0} onClick={onClose}>
                Done <kbd>Esc</kbd>
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
