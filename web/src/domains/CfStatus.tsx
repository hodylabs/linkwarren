import type { CfView } from "../api";
import { errorText } from "../copy";
import type { Tone } from "../links/linkView";
import { useApp } from "../state";
import { needsFinish } from "./domainView";
import { cfSettled, RETRYABLE } from "./useCfPoll";

type Line = [text: string, tone: Tone];

function check(v: CfView): Line {
  if (needsFinish(v)) return ["Not connected to Cloudflare yet", "bad"];
  if (v.kind === "account") return ["In your Cloudflare account", v.ownership === "verified" ? "ok" : "wait"];
  if (v.ownership === "failed") return ["Ownership check failed", "bad"];
  if (v.dns === "unknown") return ["Could not check DNS right now. Retrying.", "wait"];
  if (v.dns === "missing") return ["Waiting for the DNS record", "wait"];
  if (v.dns === "wrong_target") return ["Record points somewhere else", "bad"];
  return v.ownership === "verified" ? ["Record found, ownership verified", "ok"] : ["Record found, checking ownership", "wait"];
}

function https(v: CfView): Line {
  if (v.kind === "account")
    return v.certificate === "not_covered"
      ? ["Not covered by the free certificate. Add an advanced certificate in Cloudflare", "bad"]
      : ["Covered by your zone's certificate", "ok"];
  if (v.certificate === "issued") return ["Certificate issued by Cloudflare", "ok"];
  if (v.certificate === "failed") return ["Certificate failed", "bad"];
  return ["Certificate pending", "wait"];
}

/** The stored error of the last check: "Retrying" only where the next check can clear it. */
function problem(v: CfView): Line | null {
  const e = v.lastError;
  if (!e) return null;
  if (!RETRYABLE.has(e)) return [errorText(e), "bad"];
  if (needsFinish(v)) return ["Connecting to Cloudflare did not finish. Use Finish connecting to try again.", "bad"];
  return [e === "cloudflare_unreachable" ? "Cloudflare did not answer. Retrying." : "Cloudflare answered with an error. Retrying.", "wait"];
}

/** The DNS record to add and the live checks for an outside or account domain. Cloudflare's own text is rendered as text only. */
export function CfStatus({ view }: { view: CfView }) {
  const app = useApp();
  const i = view.instructions;
  const [c, h, p] = [check(view), https(view), problem(view)];
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => app.announce("Copied"),
      () => app.announce("Could not copy. Select the text and copy it."),
    );
  return (
    <>
      <dl className="dns">
        {i && (
          <div>
            <dt>{i.type}</dt>
            <dd className="sel">
              {i.name} → {i.target}
            </dd>
            <dd>
              <button type="button" className="btn ghost copy" aria-label={`Copy the target ${i.target}`} onClick={() => void copy(i.target)}>
                Copy
              </button>
            </dd>
          </div>
        )}
        <div>
          <dt>Check</dt>
          <dd className={c[1]}>{c[0]}</dd>
        </div>
        <div>
          <dt>HTTPS</dt>
          <dd className={h[1]}>{h[0]}</dd>
        </div>
      </dl>
      {p && <p className={p[1] === "bad" ? "err" : "hint"}>{p[0]}</p>}
      {/* Present from the first render, filled once the checks settle, so the outcome is announced once. */}
      <p className="sr-only" aria-live="polite">{cfSettled(view) ? `${c[0]}. ${h[0]}.${p ? ` ${p[0]}` : ""}` : ""}</p>
      {view.errors.map((e, n) => (
        <p key={n} className="err">
          {e}
        </p>
      ))}
      {i?.apex && <p className="hint">This is a bare domain. Its DNS provider must support CNAME flattening or an ALIAS record.</p>}
    </>
  );
}
