import { destKind } from "./linkView";

/** A destination as plain text; tel: and mailto: get a Phone or Email label in front. Never a live link. */
export function DestText({ url }: { url: string }) {
  const kind = destKind(url);
  return (
    <>
      {kind && <span className="dkind">{kind}</span>}
      {url}
    </>
  );
}
