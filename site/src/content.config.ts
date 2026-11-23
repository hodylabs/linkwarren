import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// One source: the repo's docs/*.md. Each file's frontmatter `slug` (docs/<name>) is its id and its URL.
export const collections = {
  docs: defineCollection({ loader: glob({ base: "../docs", pattern: "*.md" }), schema: docsSchema() }),
};
