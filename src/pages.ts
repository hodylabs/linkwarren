const CSS =
  `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15181D;color:#f4f4f5;font:16px system-ui,sans-serif}` +
  `main{padding:24px;text-align:center}h1{color:#FD8D27;margin:0 0 8px}p{margin:0;opacity:.8}`;
const doc = (title: string, css: string, main: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>${css}</style></head><body><main>${main}</main></body></html>`;
const page = (title: string, msg: string) => doc(title, CSS, `<h1>${title}</h1><p>${msg}</p>`);

export const notFoundPage = page("Not found", "This short link does not exist.");
export const pendingPage = page("Not active yet", "This domain is not active yet.");

// Phones: 16 px input text (no iOS zoom), 44 px tap targets.
const FORM_CSS =
  CSS +
  `form{display:grid;gap:8px;margin:16px auto 0;max-width:320px;text-align:left}label{font-weight:600}` +
  `input,button{box-sizing:border-box;width:100%;min-height:44px;font-size:16px;border-radius:6px;padding:8px 12px}` +
  `input{border:1px solid #52525b;background:#0b0d10;color:#f4f4f5}input:focus,button:focus{outline:2px solid #FD8D27;outline-offset:2px}` +
  `button{border:0;background:#FD8D27;color:#15181D;font-weight:600;cursor:pointer}.err{color:#fca5a5;opacity:1}`;
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
