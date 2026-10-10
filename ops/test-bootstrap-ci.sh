#!/bin/bash
set -euo pipefail
[[ ${CI:-} == true ]] || { echo 'Bootstrap runtime tests are CI-only'; exit 1; }
# Canonical publishes Ubuntu in ECR. Fall back to Google's official Docker Hub cache
# and the original registry when a shared runner hits a registry rate limit.
# https://ubuntu.com/docs/oci-registries/oci-how-to/getting-started/
# https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images
workspace=$(pwd)
bootstrap_image=""
for candidate in public.ecr.aws/ubuntu/ubuntu:24.04 mirror.gcr.io/library/ubuntu:24.04 ubuntu:24.04; do
  if docker pull "$candidate"; then bootstrap_image="$candidate"; break; fi
done
[[ -n "$bootstrap_image" ]] || { echo 'No official Ubuntu registry available'; exit 1; }
docker run --rm -e STREAM_PANEL_BOOTSTRAP_CONTAINER=true -v "$workspace:/work:ro" "$bootstrap_image" bash -c 'set -euo pipefail; export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq python3 openssh-client sudo iproute2 util-linux passwd >/dev/null; python3 /work/tests/deploy/bootstrap-runtime.py'
