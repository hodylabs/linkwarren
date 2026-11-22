import {
  browserSupportsWebAuthn, startAuthentication, startRegistration,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { PasskeyItem } from "../../../src/types";
import { api, ApiError } from "../api";

export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

/** The browser ceremony; a dismissed prompt is passkey_cancelled, anything else the browser refuses is passkey_failed. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    throw new ApiError(0, name === "NotAllowedError" || name === "AbortError" ? "passkey_cancelled" : "passkey_failed");
  }
}

/** Passkey sign-in; the answer's `next` is the server's safeNext of ours. */
export async function signInWithPasskey(next: string): Promise<{ next: string }> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>("POST", "/auth/passkey/options", {});
  const response = await ceremony(() => startAuthentication({ optionsJSON }));
  return api<{ next: string }>("POST", "/auth/passkey/verify", { response, next });
}

/** Registers a passkey for the signed-in person. */
export async function addPasskey(): Promise<PasskeyItem> {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>("POST", "/api/account/passkeys/options");
  const response = await ceremony(() => startRegistration({ optionsJSON }));
  return api<PasskeyItem>("POST", "/api/account/passkeys", { response });
}
