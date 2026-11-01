import coverage from "./font-coverage.json";
const ranges = coverage as Record<string, number[][]>;
export function supportsText(id: string, text: string) {
  return Array.from(text.normalize("NFC")).every(
    (c) =>
      !c.trim() ||
      (ranges[id] || []).some(
        ([a, b]) => c.codePointAt(0)! >= a && c.codePointAt(0)! <= b,
      ),
  );
}

export function fontForText(
  preferred: string,
  text: string,
): string | undefined {
  if (supportsText(preferred, text)) return preferred;
  return Object.keys(ranges).find((id) => supportsText(id, text));
}
