const page = (title: string, msg: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15181D;color:#f4f4f5;font:16px system-ui,sans-serif}` +
  `main{padding:24px;text-align:center}h1{color:#FD8D27;margin:0 0 8px}p{margin:0;opacity:.8}</style></head>` +
  `<body><main><h1>${title}</h1><p>${msg}</p></main></body></html>`;

export const notFoundPage = page("Not found", "This short link does not exist.");
export const pendingPage = page("Not active yet", "This domain is not active yet.");
