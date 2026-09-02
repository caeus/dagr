# Docker-in-Docker

dagr runs inside a container but drives the **host's** Docker daemon through a mounted
socket. It does not run a nested daemon. This is "Docker-out-of-Docker", and it creates one
path distinction worth understanding.

## The setup

```sh
docker run --rm \
  -v "$REPO_ROOT:/repo" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e HOST_REPO_ROOT="$REPO_ROOT" \
  -e WORKING_DIR="${WORKING_DIR:-$REPO_ROOT}" \
  dagr "$@"
```

So the repo exists at two paths simultaneously:

- `/repo` — inside the dagr container.
- `$HOST_REPO_ROOT` (e.g. `/Users/you/repos/thing`) — on the host, where the daemon lives.

`HOST_REPO_ROOT` is only used to translate the host `WORKING_DIR` into a package identity. Docker
build and copy operations use container-local paths.

## The rule

> **Paths interpreted by the Docker CLI use `/repo`. Paths interpreted by the Docker daemon
> use the host path.**

The Docker CLI is a client. When you give it a build context, *it* reads those files and
streams them to the daemon over the socket — so a container-local path works fine. But a
volume flag is different: the CLI passes the string through untouched and the **daemon**
resolves it against its own filesystem. A container-local path there refers to a directory the
daemon cannot see.

Applied to dagr:

| Operation | Path used | Why |
| --- | --- | --- |
| Reading `dagr.index.js` files | `/repo` | Plain `fs` calls in the dagr process. |
| `docker buildx build <context>` | `/repo/<package>` | The CLI reads and uploads the context itself. |
| `docker cp <container>:<src> <package>` for `EXPORT` | `/repo/<package>` | The **CLI** writes through the existing repo mount. |
| `docker cp <container>:<workdir>/. <mount>` for a mount | `/tmp/dagr-mounts/<identity>` | The **CLI** writes the archive to its own filesystem. |
| Reading a materialized mount | `/tmp/dagr-mounts/<identity>` | Plain `fs` calls in the dagr process. |

`wire.ts` therefore gives both the target runner and exporter the container-side `root`:

```ts
Module({
  runner: toFactory(['root', /* ... */], buildRunner),
  runCommandRunner: toClass(
    ['runner', 'dockerImageExtractor', 'root', 'currentPackage'],
    RunCommandRunner,
  ),
})
```

For both `EXPORT` and mounts, dagr uses `docker create`, `docker cp`, and `docker rm`. Temporary
containers are never started, so their entrypoints and commands do not run and images need no
shell. Exported files go through `/repo`; mounted trees live in dagr's temporary filesystem.

## Consequences

**Sibling containers, not children.** Every image dagr builds lands in the host's image
store. After a build you can inspect results directly from your shell:

```sh
docker run --rm -it packages_ui-ci-build sh
docker images | grep packages_
```

**The socket is root-equivalent.** Anything that can reach `/var/run/docker.sock` can start a
privileged container and own the host. dagr therefore never lets `dagr.index.js` files reach
that socket: build files receive no `child_process`, `fs`, process, network, or timer capability.
The reduced VM context prevents accidental ambient access, but `node:vm` is not a security
boundary and repository code remains trusted input.

**Build contexts must live under the mounted repo.** Since only `$REPO_ROOT` is mounted at
`/repo`, a target cannot reference anything outside the repository. Combined with the
build context always being the package's own directory, a target can only ever see its own
subtree.

**Layer cache is shared with everything else on the host.** Your local Docker cache, your
manual `docker build`s, and dagr all draw from the same pool. A `docker system prune` wipes
dagr's cache along with the rest.

## Running in CI

The same model works in CI as long as the runner provides a Docker socket and the repo is
checked out at a real host path:

```sh
export WORKING_DIR="$PWD"
.dagr/cli.sh run //packages/ui:ci:build
```

`cli.sh` derives `HOST_REPO_ROOT` from its own location, so as long as it runs on the machine
that owns the daemon, the paths line up. The stock `cli.sh` assumes it runs on the machine that owns the daemon and derives the host path
from its own location. Invoking it inside another container whose checkout path differs from the
daemon's view requires a custom bootstrap that passes the daemon-visible `HOST_REPO_ROOT`.

`docker cp` streams through the CLI, so extraction itself does not require the daemon to share the
runner's filesystem. A remote daemon requires a custom bootstrap that passes its Docker endpoint
and the correct daemon-visible repository path; the stock launcher mounts the local Unix socket.
