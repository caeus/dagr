#!/bin/sh
set -e

DAGR_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DAGR_DIR/.." && pwd)"

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

docker build -t dagr "$DAGR_DIR"
docker run --rm \
  -v "$REPO_ROOT:/repo" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e HOST_REPO_ROOT="$REPO_ROOT" \
  -e MOUNT_ROOT=/tmp/dagr-mounts \
  -e CLEAN_MOUNT_ROOT=1 \
  -e WORKING_DIR="${WORKING_DIR:-$REPO_ROOT}" \
  -e HOST_OS="$HOST_OS" \
  -e HOST_ARCH="$HOST_ARCH" \
  $LIBC_ENV \
  dagr "$@"
