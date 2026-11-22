import {
  browserSupportsWebAuthn, startAuthentication, startRegistration,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { PasskeyItem } from "../../../src/types";
import { api, ApiError } from "../api";

export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

/**
 * The browser ceremony; a dismissed prompt is `cancelled`, anything else the browser refuses is passkey_failed.
 * `held` is the code for InvalidStateError (registration only: this device already holds a passkey for the account).
 */
async function ceremony<T>(run: () => Promise<T>, cancelled = "passkey_cancelled", held = "passkey_failed"): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    throw new ApiError(0, name === "NotAllowedError" || name === "AbortError" ? cancelled : name === "InvalidStateError" ? held : "passkey_failed");
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
  const response = await ceremony(() => startRegistration({ optionsJSON }), "passkey_add_cancelled", "passkey_exists");
  return api<PasskeyItem>("POST", "/api/account/passkeys", { response });
}
