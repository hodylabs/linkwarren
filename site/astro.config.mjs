// The linkwarren.dev site: the landing page (src/pages/index.astro) and the docs, loaded from the repo's docs/ folder.
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";
import starlightLinksValidator from "starlight-links-validator";
import { docLinks } from "./src/doc-links.mjs";

export default defineConfig({
  site: "https://linkwarren.dev",
  // Every page is a folder with an index.html, which GitHub Pages serves at the trailing-slash URL.
  trailingSlash: "always",
  // smartPunctuation off: it would turn "--" in prose into dashes.
  markdown: { processor: satteri({ mdastPlugins: [docLinks], features: { smartPunctuation: false } }) },
  redirects: { "/docs": "/docs/getting-started/" },
  integrations: [
    starlight({
      title: "linkwarren",
      description: "A self-hosted link shortener for many domains, on Cloudflare Workers.",
      logo: { src: "../design/logo/linkwarren-mark.svg" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/hodylabs/linkwarren" }],
      // Page paths start with ../docs (relative to site/), so the base includes site/ to resolve back to the repo root.
      editLink: { baseUrl: "https://github.com/hodylabs/linkwarren/edit/main/site/" },
      customCss: [
        "@fontsource/unbounded/500.css",
        "@fontsource/ibm-plex-sans/400.css",
        "@fontsource/ibm-plex-sans/500.css",
        "@fontsource/ibm-plex-sans/600.css",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/500.css",
        "./src/styles/theme.css",
      ],
      // The docs live outside src/content/docs, so Starlight's Markdown transforms must be told about them.
      markdown: { processedDirs: ["../docs"] },
      plugins: [starlightLinksValidator({ errorOnLocalLinks: true })],
      sidebar: [
        { label: "Getting started", items: ["docs/getting-started", "docs/domains"] },
        {
          label: "Using linkwarren",
          items: ["docs/links", "docs/people-and-roles", "docs/analytics", "docs/qr-codes", "docs/vcards", "docs/import"],
        },
        { label: "Agents and API", items: ["docs/agents", "docs/api", "docs/mcp"] },
        {
          label: "Running it",
          items: ["docs/deploy", "docs/updating", "docs/backup", "docs/self-hosting-costs", "docs/troubleshooting"],
        },
        { label: "Reference", items: ["docs/configuration", "docs/privacy", "docs/spec", "docs/development"] },
      ],
    }),
  ],
  // The docs and the logo sit one level up, in the repo itself.
  vite: { server: { fs: { allow: [".."] } } },
});
