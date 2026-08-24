# Docker-in-Docker

dagr runs inside a container but drives the **host's** Docker daemon through a mounted
socket. It does not run a nested daemon. This is "Docker-out-of-Docker", and it creates one
sharp edge worth understanding, because it explains why two different repo-root paths exist.

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
| `docker run -v <dir>:/host-out` for `EXPORT` | `$HOST_REPO_ROOT/<package>` | The **daemon** resolves the bind mount. |

That is exactly why `wire.ts` binds two keys and hands them to different consumers:

```ts
.bind(runnerKey).toFun([rootKey, ...], ...)                        // /repo — build contexts
.bind(runCommandRunnerKey).toClass([runnerKey, dockerImageExtractorKey, hostRootKey, ...], ...)
                                                                    // host path — bind mounts
```

If you ever refactor extraction to receive `root` instead of `hostRoot`, `EXPORT` silently
starts writing into a fresh empty directory inside the ephemeral dagr container and the
files vanish when it exits. There is no error — the copy succeeds, into nowhere. Keep the two
straight.

## Consequences

**Sibling containers, not children.** Every image dagr builds lands in the host's image
store. After a build you can inspect results directly from your shell:

```sh
docker run --rm -it packages_ui-ci-build sh
docker images | grep packages_
```

**The socket is root-equivalent.** Anything that can reach `/var/run/docker.sock` can start a
privileged container and own the host. dagr therefore never lets `dagr.index.js` files reach
that socket — build files are sandboxed with no `child_process` and no `fs`, and the only thing
they can influence is the text of a Dockerfile. That sandbox is load-bearing for security, not
just for determinism.

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
dagr/cli.sh run packages/ui#ci#build
```

`cli.sh` derives `HOST_REPO_ROOT` from its own location, so as long as it runs on the machine
that owns the daemon, the paths line up. What does **not** work is invoking `cli.sh` from
inside another container whose repo path differs from the daemon's view — in that case set
`HOST_REPO_ROOT` yourself to the daemon-visible path.

If your CI provider gives you a genuinely remote daemon (`DOCKER_HOST` pointing elsewhere),
`EXPORT` cannot work at all: there is no shared filesystem for a bind mount. Builds still
succeed; extraction does not.
