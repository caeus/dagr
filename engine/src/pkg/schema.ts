import { z } from "zod";
import { posix } from "node:path";

// Semantic node paths are independent of the project filesystem.
export const SemanticPath = z.string().regex(/^\/(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, "expected an absolute semantic path");
export type SemanticPath = z.infer<typeof SemanticPath>;
export const NodeRef = z.string().refine(ref => {
  const parts = ref.split(':');
  return parts.length === 1
    ? SemanticPath.safeParse(ref).success
    : parts.length === 2 && parts[0]!.startsWith('//') && SemanticPath.safeParse(parts[1]).success;
}, "expected /node/path or //project:/node/path");
export type NodeRef = z.infer<typeof NodeRef>;

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

export const FilePath = z.string().refine(path =>
  path.startsWith('/') && path !== '/' && !path.endsWith('/') &&
  !path.includes('\0') && posix.normalize(path) === path,
  "expected a normalized absolute file path inside an image");
export type FileRef = Readonly<{ image: string; path: string }>;

export const Run = ImageRecipeObject.extend({
  path: FilePath.optional(),
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

export type Value = unknown;
export type Args = Readonly<Record<string, Value>>;
export const Result = z.union([
  z.strictObject({ value: z.unknown() }).refine(result => Object.hasOwn(result, 'value')),
  z.strictObject({ build: Run }),
]);
export type Result = z.infer<typeof Result>;
export type RunFn = (args: Args, host: HostPlatform) => Result;

export const NodeDef = z.strictObject({
  deps: z.record(z.string(), NodeRef).readonly(),
  run: z.custom<RunFn>(value => typeof value === 'function'),
}).readonly();
export type NodeDef = z.infer<typeof NodeDef>;
export const PackageDef = z.record(SemanticPath, NodeDef).readonly();
export type PackageDef = z.infer<typeof PackageDef>;

export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

export type MountRequest = JsonValue;
export type VolumeId = string;
export type IdentifyVolume = (request: MountRequest) => VolumeId;

export const MountImplementation = ImageRecipe;
export interface MountImplementation extends z.infer<typeof MountImplementation> {}

export const Volumes = z.record(z.string(), MountImplementation).readonly();
export interface Volumes extends z.infer<typeof Volumes> {}

// Filesystem composition is declared by dagr.mount.yaml. dagr.index.js only describes targets.
export const IndexDef = PackageDef;
export type IndexDef = PackageDef;
