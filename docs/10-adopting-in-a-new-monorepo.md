# Adopting dagr in a new monorepo

dagr has no published package. You adopt it by copying four small files into a `.dagr/`
directory at your repo root and pinning a dagr commit. You do **not** copy dagr's source: the
image builds itself by cloning this repository at the SHA you pin, so upgrading is a one-line
change and your build system is versioned as precisely as any other dependency.

## Checklist

**1. Create `.dagr/` and copy the launcher files.** Three of them are copied verbatim:

```sh
mkdir <your-repo>/.dagr
cp <source>/{cli.sh,dagr,install.sh} <your-repo>/.dagr/
```

The directory must be named `.dagr` and sit at the repo root — the `dagr` launcher finds your
repository by walking up until it sees a directory with that name. Nothing inside these three
files needs editing; `cli.sh` derives its own location.

**2. Write `.dagr/Dockerfile`.** This is the one file you author, because it carries the pin:

```dockerfile
FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-buildx git \
 && corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /dagr

# The pinned SHA is part of this layer's cache key, so bumping it here is what rebuilds dagr.
# A moving ref like `main` would cache forever and silently keep running a stale build.
RUN git clone https://github.com/caeus/dagr.git . \
 && git checkout <dagr-commit-sha>

RUN pnpm install --frozen-lockfile && pnpm exec tsc -p tsconfig.build.json

ENV REPO_ROOT=/repo

ENTRYPOINT ["node", "--experimental-vm-modules", "dist/index.js"]
```

Note `git` in the `apk add` line — the clone needs it, and dagr's own Dockerfile does not
install it because that one compiles from a local checkout instead. To upgrade dagr later, change
the SHA; nothing else moves.

**3. Install the launcher.** Once per machine, not once per repo:

```sh
.dagr/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

**4. Create `packages/`.** This is the default tree scanned by `dagr list`. It may be absent, but
packages elsewhere are only loaded when addressed by `dagr run` or a dependency.

**5. Add a base-image package.** Almost every target wants the same starting image; make it a
target so it is built once and shared:

```js
// packages/base/dagr.index.js
export default {
  ci: {
    'node-pnpm': {
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [{ RUN: 'corepack enable && corepack prepare pnpm@11.20.0 --activate' }],
        IGNORE: ['node_modules', '.git'],
      }),
    },
  },
}
```

**6. Verify the plumbing before writing anything real:**

```sh
dagr list
```

Expected output:

```
packages/base:ci:node-pnpm[]
```

Then:

```sh
dagr run packages/base:ci:node-pnpm
```

If that produces an image, dagr is working: the loader found your package, the sandbox
evaluated it, the renderer produced a Dockerfile, and the socket mount reached your daemon.

**7. Add a real package.** Start with one package and one target, get it green, then add the
next target to the same package. Resist writing a `stacks/` abstraction until you have two
packages that actually want the same facet — the third similar target is when the factory pays
for itself.

**8. Extract shared logic into `lib/` and `stacks/`** once the duplication is real. See
[07 — Conventions and layout](07-conventions-and-layout.md#the-libstacks-pattern).

## Sizing the split between `install` and `build`

The single decision that determines whether your repo feels fast: put everything that does
*not* depend on your source code into an earlier target than the code itself.

```
install    generated package.json, tsconfig, lockfile install     ← changes rarely
   ↓
build      COPY src, compile                                       ← changes constantly
```

Editing a source file then leaves the `install` image entirely cached, and only the final few
layers rebuild. Inverting this — copying `src` before installing — makes every keystroke a full
dependency install.

## Things to decide up front

- **Facet naming.** One `ci` facet is enough for most repos. Split only when you have targets
  with genuinely different lifecycles (`ci` vs `release`).
- **Where generated config lives.** dagr's model favours generating `package.json`,
  `tsconfig.json`, and lockfile-adjacent files *inside* the image from `dagr.*.js` literals, rather
  than committing them. That gives one source of truth for versions and makes drift between
  packages impossible. The cost is that host-side tooling (your editor, a local dev server)
  no longer finds those files on disk, so plan for a local-development story separately.
- **How local packages depend on each other.** See
  [07 — Depending on the local package manager inside a container](07-conventions-and-layout.md#depending-on-the-local-package-manager-inside-a-container).
- **Whether you need host-side `node_modules`.** If you want to run a dev server or have your
  editor resolve imports, remember that `EXPORT`-ed `node_modules` are Linux binaries
  ([05](05-deps-and-exports.md#exported-node_modules-are-linux-binaries)). A local install
  alongside the containerized build is usually the pragmatic answer.

## Local development alongside dagr

dagr is for reproducible builds, not for the inner loop. Nothing stops you from keeping a
normal package-manager workspace for day-to-day work and using dagr for verification and
release. The two can coexist as long as you accept that the host `node_modules` and the
in-image one are separate trees.

If you go this route, treat the `dagr.*.js` version registry as authoritative and derive host-side
manifests from it, not the other way around — otherwise the two drift and the container build
starts failing for reasons your local run cannot reproduce.

## Adapting dagr itself

The hardwired conventions in
[07 — Conventions and layout](07-conventions-and-layout.md#hardwired-you-cannot-change-without-editing-dagr)
are each one small edit away from being different. The most likely ones:

| Want | Change |
| --- | --- |
| A different build-file name | `PACKAGE_FILE` in `src/pkg/loader.ts` |
| Scan `apps/` as well as `packages/` | `scanAllPackages` in `src/pkg/loader.ts` |
| Different `.dockerignore` entries | per-target `IGNORE`; no dagr change needed |
| A new step kind | the `Step` union in `src/pkg/schema.ts` **and** the switch in `src/runner/dockerfile-renderer.ts` |
| A new command | a parser in `src/commands/index.ts`, a runner class, one branch in `CompositeCommandRunner` |

These live in dagr itself, so changing them means working in a checkout of this repository and
pinning your own commit (or fork) in `.dagr/Dockerfile`. Run `make typecheck && make test` after
any of them. The renderer and runner both have unit tests that do not require Docker.
