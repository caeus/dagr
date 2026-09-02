# Adopting Dagr in a monorepo

Dagr runs from a pinned container image. A repository keeps a small launcher under `.dagr/` and
defines packages wherever its domain model needs them.

## Install the launcher

Copy the launcher files from this repository:

```sh
mkdir <your-repo>/.dagr
cp <dagr-source>/engine/{cli.sh,dagr,install.sh} <your-repo>/.dagr/
```

Pin the runtime image in `.dagr/cli.sh`:

```sh
IMAGE="ghcr.io/caeus/dagr:<commit-sha>"
```

Then install the launcher once on the machine:

```sh
.dagr/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

The host needs Docker with Buildx and permission to reach the Docker daemon.

## Add the first package

Choose a domain directory. No directory name is privileged:

```js
// services/api/dagr.index.js
export default {
  ci: {
    build: {
      deps: [],
      run: () => ({
        FROM: 'alpine:3.22',
        steps: [
          { WORKDIR: '/repo' },
          { COPY: { src: '.', dest: '/repo' } },
          { RUN: './test.sh' },
        ],
        IGNORE: ['.git', 'out'],
      }),
    },
  },
}
```

Verify discovery, then run it:

```sh
dagr list
dagr run //services/api:ci:build
```

`dagr list` recursively finds source packages but leaves mounts opaque. Direct runs load the named
package and any dependencies they reach.

## Grow from working targets

Start with one package and one target. Add dependencies and shared helpers after duplication is
visible. A common split is:

```text
install  dependency metadata and package installation
build    source copy and compilation
```

Keeping dependency installation before frequently changed source usually improves cache reuse:

```js
build: {
  deps: ['install'],
  run: ({ images }) => ({
    FROM: images.install,
    steps: [
      { COPY: { src: 'src', dest: '/repo/src' } },
      { RUN: './build.sh' },
    ],
    IGNORE: ['out'],
  }),
}
```

Facet names and target names are repository choices. Dagr does not assign semantics to names such
as `ci`, `dev`, `build`, or `release`.

## Share build logic when useful

Helpers can live anywhere under supported `dagr.*` filenames:

```js
import { component } from '//build/dagr.component.js'

export default component({ image: 'alpine:3.22' })
```

For independently versioned build logic, mount a pinned stack image and import through its boundary.
See [Build-file environment and imports](04-sandbox-and-imports.md#mount-boundaries).

## Keep host and image concerns separate

Dagr builds in Linux images. Generated artifacts can be exported to the host, but installed
dependencies may contain Linux-specific binaries and should not be treated as a portable host
installation.

Use Dagr for reproducible build targets. A normal package-manager workspace can coexist with it for
editor support or local development.

## Upgrade deliberately

Upgrade by changing the pinned Dagr image SHA in `.dagr/cli.sh`, then run the repository's normal
Dagr checks. The pin makes runtime changes explicit and reviewable.
