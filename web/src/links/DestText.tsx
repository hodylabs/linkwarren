import type { Link } from "../api";
import { fullName } from "../../../src/vcard";
import { destKind } from "./linkView";

/** A destination as plain text; tel: and mailto: get a Phone or Email label in front, a contact card its label and name. Never a live link. */
export function DestText({ url, link }: { url: string; link?: Pick<Link, "kind" | "vcard"> }) {
  if (link?.kind === "vcard")
    return (
      <>
        <span className="dkind">Contact card</span>
        {link.vcard ? fullName(link.vcard) : ""}
      </>
    );
  const kind = destKind(url);
  return (
    <>
      {kind && <span className="dkind">{kind}</span>}
      {url}
    </>
  );
}
