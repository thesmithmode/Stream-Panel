#!/bin/bash
set -euo pipefail
[[ ${CI:-} == true ]] || { echo 'Bootstrap runtime tests are CI-only'; exit 1; }
# Canonical publishes Ubuntu in ECR; avoid shared Docker Hub anonymous limits.
# https://ubuntu.com/docs/oci-registries/oci-how-to/getting-started/
workspace=$(pwd)
docker run --rm -e STREAM_PANEL_BOOTSTRAP_CONTAINER=true -v "$workspace:/work:ro" public.ecr.aws/ubuntu/ubuntu:24.04 bash -c 'set -euo pipefail; export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq python3 openssh-client sudo iproute2 util-linux passwd >/dev/null; python3 /work/tests/deploy/bootstrap-runtime.py'
