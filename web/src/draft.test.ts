import { describe, expect, it } from "vitest";
import { rebase } from "./draft";

describe("rebase", () => {
  it("keeps fields edited after the send and takes the saved value for the rest", () => {
    const sent = { url: "b", code: 302, pass: true };
    expect(rebase({ url: "b-normalized", code: 302, pass: true }, sent, { url: "c", code: 302, pass: true })).toEqual({ url: "c", code: 302, pass: true });
    expect(rebase({ url: "b-normalized", code: 302, pass: true }, sent, sent)).toEqual({ url: "b-normalized", code: 302, pass: true });
    expect(rebase({ url: "b", code: 302, pass: true }, sent, { ...sent, pass: false })).toEqual({ url: "b", code: 302, pass: false });
  });

  it("compares nested fields by value: an untouched card from another snapshot takes the saved one", () => {
    const card = (name: string) => ({ firstName: name, phones: [{ number: "1" }] });
    expect(rebase({ v: card("B") }, { v: card("A") }, { v: card("A") })).toEqual({ v: card("B") });
    expect(rebase({ v: card("B") }, { v: card("A") }, { v: card("C") })).toEqual({ v: card("C") });
  });
});
