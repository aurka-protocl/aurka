/* global process */

/*
 * Server-only Privy request authorization for the delegated agent.
 *
 * The values in this module are Privy P-256 authorization keys, not EVM
 * private keys. They are deliberately read at request time and never returned
 * to the service, the agent, or the browser.
 */

function value(name) {
  const result = process.env[name]?.trim();
  return result || undefined;
}

function authorizationKey(operation) {
  const key =
    value("PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY") ??
    value("PRIVY_DELEGATED_SIGNER_AUTHORIZATION_PRIVATE_KEY");
  if (!key)
    throw new Error(
      "PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY is required for delegated Privy requests",
    );
  if (!operation)
    throw new Error("Delegated Privy authorization operation is required");
  return key;
}

export async function getPrivyAuthorizationContext({ operation }) {
  return { authorization_private_keys: [authorizationKey(operation)] };
}
