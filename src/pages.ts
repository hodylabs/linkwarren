/** R8: short-link pages share an origin with the dashboard in path mode, so they must never run script (both modes). */
export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
} as const;

// S12: the dashboard's tokens, dark by default and light when the OS asks. System fonts only: default-src 'none' loads no font.
const CSS =
  `:root{color-scheme:dark light;--bg:#181A1D;--card:#1E2023;--line:#2B2F33;--inset:#1C1E21;--text:#F4F6F7;--muted:#A3ADB5;--accent:#FD8D27;--ring:#FD8D27;--bad:#F2746D}` +
  `@media (prefers-color-scheme:light){:root{--bg:#FCFCFC;--card:#FFFFFF;--line:#E2E2E2;--inset:#FFFFFF;--text:#1A1A1A;--muted:#5C636B;--ring:#C8501A;--bad:#C23A34}}` +
  `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}` +
  `main{width:100%;max-width:400px;padding:28px 26px;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:12px}` +
  `h1{margin:0 0 8px;font-size:20px;font-weight:600}p{margin:0;color:var(--muted)}`;
const doc = (title: string, css: string, main: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>${css}</style></head><body><main>${main}</main></body></html>`;
const page = (title: string, msg: string) => doc(title, CSS, `<h1>${title}</h1><p>${msg}</p>`);

export const notFoundPage = page("Not found", "This short link does not exist.");
export const pendingPage = page("Not active yet", "This domain is not active yet.");

// Phones: 16 px input text (no iOS zoom), 44 px tap targets.
const FORM_CSS =
  CSS +
  `form{display:grid;gap:8px;margin:18px 0 0;text-align:left}label{font-weight:500;font-size:14px}` +
  `input,button{box-sizing:border-box;width:100%;min-height:44px;font-size:16px;font-family:inherit;border-radius:8px;padding:8px 12px}` +
  `input{border:1px solid var(--line);background:var(--inset);color:var(--text)}input:focus{outline:0;border-color:var(--ring);box-shadow:0 0 0 3px rgba(253,141,39,.2)}` +
  `button{border:1px solid var(--accent);background:var(--accent);color:#16181B;font-weight:600;cursor:pointer;margin-top:4px}` +
  `button:hover{background:#FF9C41}button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}.err{color:var(--bad);margin-top:12px}`;
const MESSAGES = {
  ask: "",
  wrong: "That password is not right. Try again.",
  limited: "Too many tries. Wait 15 minutes and try again.",
  unavailable: "Password check is unavailable right now.",
  origin: "This form must be sent from the link's own page. Open the link again.",
} as const;

/** Fixed text only: nothing from the request or the link is ever reflected. No action: posts to the current URL with its query. */
export const passwordPage = (state: keyof typeof MESSAGES): string =>
  doc(
    "Protected link",
    FORM_CSS,
    `<h1>Protected link</h1><p>Enter the password to open this link.</p>` +
      (MESSAGES[state] ? `<p class="err" role="alert">${MESSAGES[state]}</p>` : "") +
      `<form method="post"><label for="pw">Password</label>` +
      `<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>` +
      `<button type="submit">Open link</button></form>`,
  );

/**
 * S10 weekly email unsubscribe. GET only asks (mail scanners follow links), the button POSTs to the same URL, as does a mail
 * app's one-click List-Unsubscribe-Post. Fixed text only: nothing from the request is reflected.
 */
export const unsubscribePage = (state: "ask" | "done" | "bad"): string =>
  state === "ask"
    ? doc("Weekly email", FORM_CSS, `<h1>Weekly email</h1><p>Stop the weekly clicks summary?</p><form method="post"><button type="submit">Unsubscribe</button></form>`)
    : state === "done"
      ? page("Unsubscribed", "You will not get the weekly email any more. You can turn it on again in your account.")
      : page("Link not valid", "This unsubscribe link is not valid any more. Turn the weekly email off in your account.");
