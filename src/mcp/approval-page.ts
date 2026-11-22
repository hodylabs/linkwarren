/** Escapes text for HTML element content and double-quoted attributes. Every client-supplied string goes through it. */
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Brand tokens (dark surface, orange accent) and the system font stack; no scripts, no external loads.
const CSS =
  `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15181D;color:#f4f4f5;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}` +
  `main{box-sizing:border-box;width:100%;max-width:440px;padding:24px 16px}h1{color:#FD8D27;font-size:20px;margin:0 0 8px}p{margin:0 0 10px}` +
  `.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.muted{opacity:.75;font-size:13px}.warn{color:#fbbf24}` +
  `fieldset{border:1px solid #2a2f37;border-radius:8px;margin:12px 0;padding:8px 12px}legend{padding:0 4px;font-weight:600}` +
  `label{display:flex;gap:8px;align-items:flex-start;padding:6px 0;cursor:pointer}label span{display:block}input{margin-top:3px;accent-color:#FD8D27}` +
  `.row{display:flex;gap:8px;margin-top:14px}button{flex:1;min-height:44px;font-size:16px;border-radius:6px;padding:8px 12px;cursor:pointer;font-weight:600}` +
  `.approve{border:0;background:#FD8D27;color:#15181D}.deny{border:1px solid #52525b;background:transparent;color:#f4f4f5}` +
  `:focus-visible{outline:2px solid #FD8D27;outline-offset:2px}`;

const doc = (title: string, main: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${main}</main></body></html>`;

/** A fixed-text message page (refusals and errors); nothing from the request is reflected. */
export const messagePage = (title: string, msg: string) => doc(title, `<h1>${esc(title)}</h1><p>${esc(msg)}</p>`);

export type ApprovalView = {
  clientName: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  who: { email: string; role: string };
  handle: string;
};

/** The consent form. The client name and redirect host are client-supplied: escaped, and the host shown in bold mono. */
export function renderApproval(v: ApprovalView): string {
  const name = esc(v.clientName);
  return doc(
    `Connect ${v.clientName}`,
    `<h1>Connect ${name}</h1>` +
      `<p>${name} wants to use linkwarren as you. It will return to <b class="mono">${esc(v.redirectHost)}</b>.</p>` +
      (v.redirectIsLoopback ? `<p class="warn">This returns to an app on your own computer (local app).</p>` : "") +
      `<p class="muted">Signed in as ${esc(v.who.email)} (${esc(v.who.role)})</p>` +
      `<form method="post" action="/authorize">` +
      `<input type="hidden" name="handle" value="${esc(v.handle)}">` +
      `<fieldset><legend>Access</legend>` +
      `<label><input type="radio" name="access" value="read" checked><span><b>Read only</b><span class="muted">Search and read links and domains you can use</span></span></label>` +
      `<label><input type="radio" name="access" value="write"><span><b>Read and write</b><span class="muted">Also create and edit links, shown in the audit log as you via ${name}</span></span></label>` +
      `<label><input type="checkbox" name="del" value="1"><span>Also allow deleting links<span class="muted">Needs read and write. Deleted slugs stay locked.</span></span></label>` +
      `</fieldset>` +
      `<p class="muted">You can change or disconnect this any time in API &amp; agents.</p>` +
      `<div class="row"><button class="approve" type="submit" name="action" value="approve" autofocus>Approve</button>` +
      `<button class="deny" type="submit" name="action" value="deny">Deny</button></div>` +
      `</form>`,
  );
}
