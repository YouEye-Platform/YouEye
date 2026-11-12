const values = new Map<string, { value: string }>();
export async function cookies() {
  return { get: (name: string) => values.get(name), set: (name: string, value: string) => values.set(name, { value }), delete: (name: string) => values.delete(name) };
}
