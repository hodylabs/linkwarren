/** A screen that is not built yet: its title and one line about when it arrives. No stand-in controls. */
export function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <>
      <header className="top">
        <h1>{title}</h1>
      </header>
      <section className="soon" aria-label={title}>
        <p>{text}</p>
      </section>
    </>
  );
}
