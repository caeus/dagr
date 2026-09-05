# Filesystem composition

Dagr composes filesystems through three separate concepts:

| Concept | Owned by | Meaning |
| --- | --- | --- |
| Mount request | The repository containing the attachment directory | What filesystem that directory wants |
| Volume ID | The invocation root | The global identity of that filesystem |
| Volume implementation | The invocation root | How Dagr builds that filesystem |

The relationship is: **you mount a volume**. A mount path is an attachment point, not an identity.

## Request a volume

Put `dagr.mount.yaml` in the directory where the filesystem should appear:

```yaml
# vendor/foo/dagr.mount.yaml
repo: github.com/acme/foo
version: "^3"
variant:
  platform: linux
```

The file may contain any JSON-compatible YAML value, including nested objects, arrays, scalars, and
`null`. Dagr can discover and parse it without evaluating `dagr.index.js`.

The request is a suggestion, not a canonical identity. A mounted repository can contain further
`dagr.mount.yaml` files, but it cannot choose global identities or implementations.

## Identify the volume

The root monorepo exports one `identifyVolume` function from `.dagr/config.js`:

```js
export const identifyVolume = request => request.repo
```

The function receives the parsed request and must synchronously return a string. `.dagr/config.js`
runs in a dedicated minimal sandbox. It has deterministic JavaScript primitives, but no `Buffer`,
console, clock, randomness, network, process, filesystem, timers, WebAssembly, or dynamic code
generation. Static and dynamic imports are rejected. Dagr recreates and deep-freezes the mount
request inside that VM context before calling `identifyVolume`, so the request cannot carry host
constructors across the boundary.

The root decides which request differences matter. These requests:

```yaml
repo: github.com/acme/foo
version: "^3"
```

```yaml
repo: github.com/acme/foo
version: "^4"
```

both identify the volume `github.com/acme/foo` when the function returns `request.repo`. They do
not create two versions. Configuration inside a mounted repository is ignored.

## Implement the volume

The root monorepo maps IDs to image recipes in `.dagr/volumes.yaml`:

```yaml
"github.com/acme/foo":
  FROM: ghcr.io/acme/foo:3.8.1
  steps:
    - RUN: test -f /workspace/dagr.index.js
  IGNORE:
    - .git
```

Volume definitions use Dagr's existing image recipe schema: `FROM`, `steps`, and `IGNORE`. They do
not have target fields such as `deps`, `run`, or `EXPORT`.

The root monorepo directory is the build context. An ordinary `COPY` in a volume recipe therefore
reads paths relative to that root, and `IGNORE` controls that context. The built image must finish
with a `WORKDIR` other than `/`. Dagr extracts that directory and treats it as the mounted volume
root.

The root should pin implementation inputs when reproducibility matters. Requests from mounted
repositories do not independently select versions.

## Resolution and laziness

When traversal crosses a mount boundary, Dagr:

1. parses `dagr.mount.yaml`;
2. passes the request to the root `identifyVolume`;
3. looks up the returned ID in the root `.dagr/volumes.yaml`;
4. builds and extracts that implementation if the ID has not been materialized yet;
5. continues traversal from the resulting filesystem as a new root boundary.

Actual materialization is lazy. `dagr list` leaves mount contents opaque, and an unused mount does
not require a matching entry in `.dagr/volumes.yaml`. Discovery may still parse the mount request.
The root `.dagr` directory is control metadata and is excluded from package discovery.

Within one invocation, Dagr caches materialization by volume ID. Different requests and different
attachment paths that identify as the same ID share one logical filesystem:

```text
//a/foo//packages/core
//b/foo//packages/core
```

Those are distinct addresses into the same volume. This global identity permits diamonds: two
mounted repositories may request the same dependency volume, and both branches converge on one
materialization.

## Addressing across boundaries

Dagr keeps filesystem-oriented `//` addressing. It does not add repository prefixes or drive-like
namespaces:

```text
//vendor/foo//packages/core:ci:test
```

The first `//` is the invocation root. The second crosses the mount at `vendor/foo`. Every further
mount boundary adds another `//`:

```text
//a//b//c//pkg:ci:test
```

The same syntax applies to imports and mounted `COPY` sources:

```js
import stack from '//stacks/typescript//dagr.stack.js'

{ COPY: { src: 'vendor/foo//assets/logo.svg', dest: '/assets/logo.svg' } }
```

Once inside a volume, a leading `//` resolves from that volume root. A volume cannot observe the
path through which its repository was mounted.

## Coexisting with targets

An attachment directory may contain both files:

```text
vendor/foo/
├── dagr.index.js
└── dagr.mount.yaml
```

`//vendor/foo:ci:test` addresses the local target definition. `//vendor/foo//:ci:test` crosses the
mount and addresses a target at the volume root. Neither file defines or overrides the other.

## Migrating the former index mount shape

The former index shape has been removed:

```js
export default {
  '/': { FROM: '...', steps: [], IGNORE: [] },
}
```

Move the request to `dagr.mount.yaml`, move the implementation to the root `.dagr/volumes.yaml`,
and add or update the root `.dagr/config.js`. Dagr reports this migration directly if it encounters
an index whose default export still owns `/`.

## Failures

Errors identify the layer that failed and retain their underlying cause:

| Failure | Diagnostic context |
| --- | --- |
| Malformed or non-JSON mount request | Mount path |
| Missing, invalid, or throwing `identifyVolume` | Mount path |
| Non-string volume ID | Mount path and received type |
| Malformed or invalid volume registry | Volume ID and mount path |
| Undefined traversed volume | Canonical volume ID and mount path |
| Failed build, extraction, or unreadable root | Canonical volume ID and mount path |
| Recursive volume identity | Volume ID and complete mount trace |

See [Troubleshooting](11-troubleshooting.md#a-volume-mount-fails) for a short repair checklist.
