import { useEffect, useRef, useState, type ReactNode } from "react";
import { PHONE_TYPES, VCARD_MAX, type PhoneType, type VCard } from "../../../src/vcard";
import { photoSrc, resizePhoto } from "./photo";

const PHONE_LABEL: Record<PhoneType, string> = { cell: "Mobile", work: "Work", home: "Home", other: "Other" };

/** The text for a bad_vcard `field` (the same names on the server and in checkVcard). */
export function vcardFieldText(field: string): string {
  const [head] = field.split(".");
  switch (head) {
    case "name": return "Enter a first name, a last name or an organization.";
    case "photo": return "Use a JPEG or PNG photo of at most 64 KB.";
    case "phones": return "Use digits, spaces and + - ( ) . / only, at most 40 characters.";
    case "emails": return "Enter an email address like name@example.com.";
    case "websites": return "Enter a full http or https address, like https://example.com.";
    case "rows": return "Add at most 10 phones, 10 emails and 10 websites.";
    case "note": return "Notes can be at most 1000 characters, without special control characters.";
    default: return "Check this field: it is too long or has a line break or special character.";
  }
}

/** Blank rows dropped: the form keeps them while someone types, the API never gets them. */
export const cleanVcard = (v: VCard): VCard => ({
  ...v, phones: v.phones.filter((p) => p.number.trim()), emails: v.emails.filter((e) => e.trim()), websites: v.websites.filter((w) => w.trim()),
});

type TextKey = "firstName" | "lastName" | "org" | "title" | "note";
type AddrKey = keyof VCard["address"];
type ListKey = "phones" | "emails" | "websites";

/**
 * The contact card fields of a vCard link. `field` is the bad_vcard field to mark (its error shows under it). Rows of phones,
 * emails and websites are added and removed with buttons; focus moves to the new row, or back to Add after a remove.
 */
export function VcardForm({ id, value, onChange, field, readOnly }: { id: string; value: VCard; onChange(v: VCard): void; field?: string | null; readOnly?: boolean }) {
  const latest = useRef(value);
  latest.current = value;
  const set = (p: Partial<VCard>) => onChange({ ...latest.current, ...p });
  const box = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (!focusNext.current) return;
    box.current?.querySelector<HTMLElement>(focusNext.current)?.focus();
    focusNext.current = null;
  });

  // "name" (no name at all) marks the first name box.
  const bad = (key: string) => field === key || (field === "name" && key === "firstName");
  const err = (key: string): ReactNode =>
    field === key ? (
      <p className="err" role="alert" id={`${id}-err`}>
        {vcardFieldText(field)}
      </p>
    ) : null;
  const inv = (key: string) => (bad(key) ? { "aria-invalid": true as const, "aria-describedby": `${id}-err` } : {});

  const text = (key: TextKey, label: string) => (
    <div className="field stack">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input id={`${id}-${key}`} className="input sans" value={value[key]} maxLength={VCARD_MAX[key]} readOnly={readOnly} autoComplete="off" {...inv(key)}
        onChange={(e) => set({ [key]: e.target.value })} />
      {err(key)}
    </div>
  );
  const addr = (key: AddrKey, label: string) => (
    <div className="field stack">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input id={`${id}-${key}`} className="input sans" value={value.address[key]} maxLength={VCARD_MAX[key]} readOnly={readOnly} autoComplete="off" {...inv(`address.${key}`)}
        onChange={(e) => set({ address: { ...latest.current.address, [key]: e.target.value } })} />
      {err(`address.${key}`)}
    </div>
  );

  const add = (key: ListKey) => {
    focusNext.current = `[data-row="${key}-${value[key].length}"]`;
    set(key === "phones" ? { phones: [...value.phones, { type: "cell", number: "" }] } : { [key]: [...value[key], ""] });
  };
  const remove = (key: ListKey, i: number) => {
    focusNext.current = `[data-add="${key}"]`;
    set({ [key]: (value[key] as unknown[]).filter((_, j) => j !== i) } as Partial<VCard>);
  };
  const list = (key: ListKey, title: string, one: string, row: (i: number, n: number) => ReactNode) => (
    <div className="vc-list" role="group" aria-label={title}>
      <h4>{title}</h4>
      {value[key].map((_, i) => (
        <div key={i}>
          <div className="vc-row">
            {row(i, i + 1)}
            {!readOnly && (
              <button type="button" className="btn" aria-label={`Remove ${one} ${i + 1}`} onClick={() => remove(key, i)}>
                Remove
              </button>
            )}
          </div>
          {err(`${key}.${i}`)}
        </div>
      ))}
      {!readOnly && value[key].length < VCARD_MAX.rows && (
        <button type="button" className="btn" data-add={key} onClick={() => add(key)}>
          Add {one}
        </button>
      )}
    </div>
  );

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setPhotoError(null);
    setReading(true);
    try {
      set({ photo: await resizePhoto(file) });
    } catch {
      setPhotoError("This image could not be read. Try a JPEG or PNG photo.");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="vc" ref={box}>
      <div className="vc-photo">
        {value.photo ? <img className="vc-img" src={photoSrc(value.photo)} alt="Contact photo" width={64} height={64} /> : <span className="vc-img" aria-hidden="true" />}
        {!readOnly && (
          <>
            <button type="button" className="btn" ref={pickRef} disabled={reading} {...inv("photo")} onClick={() => fileRef.current?.click()}>
              {reading ? "Reading photo..." : value.photo ? "Change photo" : "Add photo"}
            </button>
            {value.photo && (
              <button type="button" className="btn" onClick={() => {
                  set({ photo: null });
                  pickRef.current?.focus();
                }}>
                Remove photo
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="vc-file"
              onChange={(e) => void pick(e.target.files?.[0])} />
          </>
        )}
      </div>
      {!readOnly && <p className="utm-note">Resized to at most 256 by 256 pixels in your browser before it is saved.</p>}
      {photoError && <p className="err" role="alert">{photoError}</p>}
      {err("photo")}
      <div className="vc-two">
        {text("firstName", "First name")}
        {text("lastName", "Last name")}
        {text("org", "Organization")}
        {text("title", "Job title")}
      </div>
      {err("name")}
      {list("phones", "Phones", "phone", (i, n) => (
        <>
          <select className="input sans" aria-label={`Phone ${n} type`} value={value.phones[i]!.type} disabled={readOnly}
            onChange={(e) => set({ phones: latest.current.phones.map((p, j) => (j === i ? { ...p, type: e.target.value as PhoneType } : p)) })}>
            {PHONE_TYPES.map((t) => <option key={t} value={t}>{PHONE_LABEL[t]}</option>)}
          </select>
          <input className="input sans" data-row={`phones-${i}`} aria-label={`Phone ${n}`} type="tel" inputMode="tel" autoComplete="off" maxLength={VCARD_MAX.phone}
            value={value.phones[i]!.number} readOnly={readOnly} {...inv(`phones.${i}`)}
            onChange={(e) => set({ phones: latest.current.phones.map((p, j) => (j === i ? { ...p, number: e.target.value } : p)) })} />
        </>
      ))}
      {list("emails", "Emails", "email", (i, n) => (
        <input className="input sans" data-row={`emails-${i}`} aria-label={`Email ${n}`} type="email" inputMode="email" autoComplete="off" spellCheck={false}
          maxLength={VCARD_MAX.email} value={value.emails[i]!} readOnly={readOnly} {...inv(`emails.${i}`)}
          onChange={(e) => set({ emails: latest.current.emails.map((x, j) => (j === i ? e.target.value : x)) })} />
      ))}
      {list("websites", "Websites", "website", (i, n) => (
        <input className="input sans" data-row={`websites-${i}`} aria-label={`Website ${n}`} inputMode="url" autoComplete="off" spellCheck={false}
          placeholder="https://example.com" maxLength={VCARD_MAX.website} value={value.websites[i]!} readOnly={readOnly} {...inv(`websites.${i}`)}
          onChange={(e) => set({ websites: latest.current.websites.map((x, j) => (j === i ? e.target.value : x)) })} />
      ))}
      {err("rows")}
      <h4>Address</h4>
      {addr("street", "Street")}
      <div className="vc-two">
        {addr("city", "City")}
        {addr("region", "Region")}
        {addr("postalCode", "Postal code")}
        {addr("country", "Country")}
      </div>
      <div className="field stack">
        <label htmlFor={`${id}-note`}>Note</label>
        <textarea id={`${id}-note`} className="input sans" rows={3} value={value.note} maxLength={VCARD_MAX.note} readOnly={readOnly} {...inv("note")}
          onChange={(e) => set({ note: e.target.value })} />
        {err("note")}
      </div>
    </div>
  );
}
