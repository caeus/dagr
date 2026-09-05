#!/bin/sh
set -e

DAGR_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DAGR_DIR/.." && pwd)"
PIN="ghcr.io/caeus/dagr:145bdefbd5e9341e2d2da6286e606c1f29d92602"

TARGET_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-}"
unset DOCKER_DEFAULT_PLATFORM

HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  arm64 | aarch64) HOST_ARCH=arm64 ;;
  x86_64 | amd64) HOST_ARCH=x64 ;;
  *) HOST_ARCH="$(uname -m)" ;;
esac

LIBC_ENV=""
if [ "$HOST_OS" = linux ]; then
  if ldd --version 2>&1 | grep -qi musl; then LIBC_ENV="-e HOST_LIBC=musl"; else LIBC_ENV="-e HOST_LIBC=glibc"; fi
fi

PLATFORM_ENV=""
if [ -n "$TARGET_PLATFORM" ]; then PLATFORM_ENV="-e DOCKER_DEFAULT_PLATFORM=$TARGET_PLATFORM"; fi

dagr_docker_run_container() {
  docker run --rm --pull=missing \
    -v "$REPO_ROOT:/repo" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e HOST_REPO_ROOT="$REPO_ROOT" \
    -e MOUNT_ROOT=/tmp/dagr-mounts \
    -e CLEAN_MOUNT_ROOT=1 \
    -e WORKING_DIR="${WORKING_DIR:-$REPO_ROOT}" \
    -e HOST_OS="$HOST_OS" \
    -e HOST_ARCH="$HOST_ARCH" \
    $LIBC_ENV \
    $PLATFORM_ENV \
    "$@"
}

dagr_docker_run() {
  image="$1"
  shift
  if [ "$image" = "$PIN" ]; then
    # The released engine still needs the former index mount shape to bootstrap this checkout.
    dagr_docker_run_container \
      -v "$DAGR_DIR/bootstrap-typescript:/repo/engine/stacks/typescript:ro" \
      "$image" "$@"
  else
    dagr_docker_run_container "$image" "$@"
  fi
}

# DOGFEED=true rebuilds the engine from this working tree with the pinned
# release, then runs the requested command with that freshly built engine.
if [ "${DOGFEED:-}" = true ]; then
  dagr_docker_run "$PIN" run //engine:ci:image
  dagr_docker_run engine-ci-image "$@"
else
  dagr_docker_run "$PIN" "$@"
fi
