// Helpers to show and compare a full receiving address.

// "HYKw Do4Z MFoT ..." : groups of 4 so a person can read it aloud and compare.
export function chunk(address, size = 4) {
  return String(address).match(new RegExp(`.{1,${size}}`, "g")) ?? [];
}

// Exact, case-sensitive comparison of the whole string. No prefix/suffix shortcut:
// lookalike addresses are made to match the first and last few characters.
export function compareAddresses(approved, actual) {
  const a = String(approved ?? ""), b = String(actual ?? "");
  const firstDiff = [...a].findIndex((ch, i) => ch !== b[i]);
  const match = a.length > 0 && a === b;
  return { match, approvedLength: a.length, actualLength: b.length, firstDifferenceAt: match ? null : (firstDiff === -1 ? Math.min(a.length, b.length) : firstDiff) };
}
