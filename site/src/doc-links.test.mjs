import { test } from "node:test";
import assert from "node:assert/strict";
import { docHref } from "./doc-links.mjs";

test("sibling doc links become site pages", () => {
  assert.equal(docHref("domains.md"), "/docs/domains/");
  assert.equal(docHref("./deploy.md#mcp_enabled"), "/docs/deploy/#mcp_enabled");
  assert.equal(docHref("self-hosting-costs.md#workers"), "/docs/self-hosting-costs/#workers");
});

test("everything else is left alone", () => {
  for (const u of ["https://example.com/a.md", "#limits", "../README.md", "/docs/api/", "mailto:a@example.com", "notes.txt"])
    assert.equal(docHref(u), u);
});
