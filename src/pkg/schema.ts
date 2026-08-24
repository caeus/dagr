import { z } from "zod";

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

export const Run = z
  .object({
    FROM: z.string(),
    steps: z.array(Step).readonly(),
    IGNORE: z.array(z.string()).readonly(),
    EXPORT: z.record(z.string(), z.string()).readonly().optional(),
  })
  .readonly()
  .superRefine((run, ctx) => {
    for (const [src, dest] of Object.entries(run.EXPORT ?? {})) {
      const contentsOf = src.endsWith("/");
      const intoDirectory = dest.endsWith("/");
      const destPath = dest.replace(/\/+$/, "");
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
  .object({
    deps: z.array(z.string()).readonly(),
    run: z.custom<RunFn>((v) => typeof v === "function"),
  })
  .readonly();
export interface TargetDef extends z.infer<typeof TargetDef> {}

export const FacetDef = z.record(z.string(), TargetDef).readonly();
export interface FacetDef extends z.infer<typeof FacetDef> {}

export const PackageDef = z.record(z.string(), FacetDef).readonly();
export interface PackageDef extends z.infer<typeof PackageDef> {}
