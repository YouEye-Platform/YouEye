import { designSchema } from "./lib/design";

/** A personal Studio document owns its text. Legacy overrides only own styling. */
export function resolveTitle<S extends object, P extends object>(
  shared: { site_name: string; site_name_style: S | null },
  personal: P | null | undefined,
): { name: string; style: S | P | null } {
  const own = personal && typeof personal === "object" && !Array.isArray(personal) ? personal : null;
  const design = designSchema.safeParse(own && "mytitle" in own ? own.mytitle : undefined);
  return {
    name: design.success ? design.data.name : shared.site_name,
    style: own ?? shared.site_name_style,
  };
}
