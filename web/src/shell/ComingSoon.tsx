import { ScreenHeader } from "./ui";

/** A screen that is not built yet: its title and one line about when it arrives. No stand-in controls. */
export function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <>
      <ScreenHeader title={title} />
      <section className="soon" aria-label={title}>
        <p>{text}</p>
      </section>
    </>
  );
}
