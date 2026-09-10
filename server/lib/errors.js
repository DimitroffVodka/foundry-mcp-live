/**
 * Stable codes for the failures a user hits while *setting the bridge up*.
 *
 * Not a general error taxonomy — the other ~240 `throw new Error` sites in
 * this repo are internal invariants, and giving those codes would be paperwork
 * with no reader. These five are different: they are the ones an operator (or
 * the LLM on the other end of the socket) sees when the thing simply will not
 * connect, and a stable code is something both can look up and act on.
 *
 * A freeform string makes a model guess. `FML-0001` makes it act.
 *
 * Adding a code: add it here AND add a `## FML-NNNN` section to docs/errors.md.
 * test/error-codes.test.js fails the build if those two drift apart.
 */

export const ERROR_CODES = {
  "FML-0001": "No GM bridge connected",
  "FML-0002": "No bridge connected for the requested user",
  "FML-0003": "Write-gated tool called while FOUNDRY_MCP_ALLOW_WRITE is unset",
  "FML-0004": "Invalid or missing bearer token",
  "FML-0005": "Client relaunch is misconfigured",
};

const DOCS = "docs/errors.md";

/** `FML-0001: No GM bridge connected. — see docs/errors.md#fml-0001` */
export function codedMessage(code, message) {
  return `${code}: ${message} — see ${DOCS}#${code.toLowerCase()}`;
}

/** An Error carrying the code both in `.code` and in the message text. */
export function codedError(code, message) {
  const err = new Error(codedMessage(code, message));
  err.code = code;
  return err;
}
