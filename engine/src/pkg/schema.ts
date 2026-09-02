import { z } from "zod";
import { posix } from "node:path";

// Facet and target names are embedded in FQTs, image tags, log labels, and shell-facing CLI
// arguments. Keep them to portable filename characters, and require an alphanumeric first
// character so a name cannot be mistaken for an option, a hidden path, or a directive.
export const Name = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "must start with an ASCII letter or digit and contain only ASCII letters, digits, '.', '_', or '-'",
  );
export type Name = z.infer<typeof Name>;

export const Copy = z
  .object({ from: z.string().optional(), src: z.string(), dest: z.string() })
  .strict()
  .readonly();
export interface Copy extends z.infer<typeof Copy> {}

export const Step = z.union([
  z.object({ RUN: z.string() }).strict().readonly(),
  z.object({ COPY: Copy }).strict().readonly(),
  z.object({ WORKDIR: z.string() }).strict().readonly(),
  z.object({ ENV: z.record(z.string(), z.string()).readonly() }).strict().readonly(),
  z.object({ ENTRYPOINT: z.array(z.string()).readonly() }).strict().readonly(),
  z.object({ CMD: z.array(z.string()).readonly() }).strict().readonly(),
]);
export type Step = z.infer<typeof Step>;

const ImageRecipeObject = z.object({
  FROM: z.string(),
  steps: z.array(Step).readonly(),
  IGNORE: z.array(z.string()).readonly(),
}).strict();

export const ImageRecipe = ImageRecipeObject.readonly();
export interface ImageRecipe extends z.infer<typeof ImageRecipe> {}

export const Run = ImageRecipeObject.extend({
  EXPORT: z.record(z.string(), z.string()).readonly().optional(),
})
  .strict()
  .readonly()
  .superRefine((run, ctx) => {
    for (const [src, dest] of Object.entries(run.EXPORT ?? {})) {
      const contentsOf = src.endsWith("/");
      const intoDirectory = dest.endsWith("/");
      const destPath = dest.replace(/\/+$/, "");
      const normalizedDest = posix.normalize(dest);
      if (
        posix.isAbsolute(dest) ||
        normalizedDest === ".." ||
        normalizedDest.startsWith("../")
      )
        ctx.addIssue({
          code: "custom",
          message: `EXPORT "${src}" -> "${dest}": destination must stay inside the package directory`,
        });
      if (contentsOf && !intoDirectory)
        ctx.addIssue({
          code: "custom",
          message: `EXPORT "${src}" -> "${dest}": a trailing slash on the source means "the contents of", so the destination must end in "/" too`,
        });
      if (!intoDirectory && (destPath === "" || destPath === "."))
        ctx.addIssue({
          code: "custom",
          message: `EXPORT "${src}" -> "${dest}": cannot replace the package directory itself; use "./" to merge into it`,
        });
    }
  });
export interface Run extends z.infer<typeof Run> {}

export interface HostPlatform {
  readonly os: string;
  readonly arch: string;
  // Linux-only concept; absent elsewhere rather than defaulted.
  readonly libc?: "glibc" | "musl";
}

export interface RunContext {
  readonly images: Readonly<Record<string, string>>;
  readonly host: HostPlatform;
}

export type RunFn = (ctx: RunContext) => Run;

export const TargetDef = z
  .looseObject({
    deps: z.array(z.string()).readonly(),
    run: z.custom<RunFn>((v) => typeof v === "function"),
  })
  .readonly();
export interface TargetDef extends z.infer<typeof TargetDef> {}

export const FacetDef = z.record(Name, TargetDef).readonly();
export interface FacetDef extends z.infer<typeof FacetDef> {}

export const PackageDef = z.record(Name, FacetDef).readonly();
export interface PackageDef extends z.infer<typeof PackageDef> {}

export const MountDef = ImageRecipe;
export interface MountDef extends z.infer<typeof MountDef> {}

export const MountIndex = z
  .object({ "/": MountDef })
  .strict()
  .readonly();
export interface MountIndex extends z.infer<typeof MountIndex> {}

export const IndexDef = z.union([MountIndex, PackageDef]);
export type IndexDef = z.infer<typeof IndexDef>;
