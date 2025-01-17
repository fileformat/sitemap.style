#!/bin/bash

set -o errexit
set -o pipefail
set -o nounset

echo "INFO: build starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "INFO: Jekyll location = $(which jekyll)"
echo "INFO: Jekyll version = $(jekyll --version)"

bundle exec jekyll build --source docs

echo "INFO: build complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
