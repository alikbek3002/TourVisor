/**
 * Pure allowlist matching, isolated in its own module so it can be unit-tested
 * without pulling in the message pipeline (and its Claude/WAHA side effects).
 */

/**
 * Whether a message from `phone`/`chatId` is allowed. Empty allowlist = allow
 * everyone. An entry matches by exact phone, exact chatId, or as a digit suffix
 * of the phone (so "555123456" matches "996555123456"). Entries with no digits
 * never suffix-match — this guards against an empty-string `endsWith` that would
 * otherwise allow everyone.
 */
export function matchesAllowlist(phone: string, chatId: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((a) => {
    if (a === phone || a === chatId) return true;
    const digits = a.replace(/\D/g, '');
    return digits !== '' && phone.endsWith(digits);
  });
}
