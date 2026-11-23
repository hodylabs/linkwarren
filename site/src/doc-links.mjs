// Sätteri mdast plugin for the docs in ../docs. They are written for GitHub, so on the site:
// - a relative link to a sibling doc (`domains.md#status`) becomes its page (`/docs/domains/#status`);
// - the file's own `# Title` is dropped, because Starlight prints the frontmatter title as the page heading.
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";

const DOCS = resolve(fileURLToPath(new URL("../../docs", import.meta.url))) + sep;
const SIBLING = /^(?:\.\/)?([a-z0-9-]+)\.md(#[^\s]*)?$/;

/** `domains.md#x` to `/docs/domains/#x`; anything else (absolute, external, anchors, other files) unchanged. */
export const docHref = (url) => {
  const m = SIBLING.exec(url);
  return m ? `/docs/${m[1]}/${m[2] ?? ""}` : url;
};

export const docLinks = ({ fileURL }) => {
  if (!fileURL || !fileURLToPath(fileURL).startsWith(DOCS)) return;
  return {
    name: "linkwarren-doc-links",
    link(node, ctx) {
      const href = docHref(node.url);
      if (href !== node.url) ctx.setProperty(node, "url", href);
    },
    heading(node, ctx) {
      if (node.depth === 1) ctx.removeNode(node);
    },
  };
};
