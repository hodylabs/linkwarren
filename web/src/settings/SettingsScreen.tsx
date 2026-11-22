import { useState } from "react";
import { ScreenHeader } from "../shell/ui";
import { CloudflareSection } from "./CloudflareSection";

const SECTIONS = ["This instance", "Sign-in", "Cloudflare", "Email", "Link defaults", "Data and retention", "Backups and export"] as const;
type Section = (typeof SECTIONS)[number];

export function SettingsScreen() {
  const [section, setSection] = useState<Section>("Cloudflare");
  return (
    <>
      <ScreenHeader title="Settings" text="Owner only" />
      <div className="setwrap">
        <nav className="subnav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s} type="button" aria-current={s === section ? "page" : undefined} onClick={() => setSection(s)}>
              {s}
            </button>
          ))}
        </nav>
        <div className="setmain">
          {section === "Cloudflare" ? (
            <CloudflareSection />
          ) : (
            <section className="soon" aria-label={section}>
              <p>Instance settings and the first-run setup arrive in a later version.</p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
