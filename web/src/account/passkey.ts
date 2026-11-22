import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { api } from "../api";

export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

/**
 * Registers a passkey for the signed-in person. Server errors (passkey_limit, passkey_failed) reject as ApiError;
 * a person who closes the browser prompt gets `false`, which is not an error.
 */
export async function addPasskey(): Promise<boolean> {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("POST", "/api/account/passkeys/options", {});
  let response;
  try {
    response = await startRegistration({ optionsJSON });
  } catch (e) {
    // The prompt was cancelled or timed out (NotAllowedError), or this authenticator already holds one (InvalidStateError).
    if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "InvalidStateError" || e.name === "AbortError")) return false;
    throw e;
  }
  await api("POST", "/api/account/passkeys", { response });
  return true;
}
