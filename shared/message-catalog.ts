export type Messages = { [key: string]: string | Messages };

/** Fill missing keys from English without replacing translated sibling messages. */
export function mergeMessages(english: Messages, translated: Messages): Messages {
  const result: Messages = { ...english };
  for (const [key, value] of Object.entries(translated)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const fallback = result[key];
    result[key] = typeof value === "object" && typeof fallback === "object"
      ? mergeMessages(fallback, value) : value;
  }
  return result;
}
