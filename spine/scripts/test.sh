#!/bin/bash
# YE-Spine Test Runner
# Usage: ./scripts/test.sh [--coverage] [--race] [--verbose]
#
# Options:
#   --coverage   Generate coverage report (coverage.out + per-function summary)
#   --race       Enable race detector
#   --verbose    Verbose test output

set -euo pipefail

COVERAGE=false
RACE=false
VERBOSE=false

for arg in "$@"; do
    case $arg in
        --coverage) COVERAGE=true ;;
        --race) RACE=true ;;
        --verbose) VERBOSE=true ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

echo "=== YE-Spine Test Runner ==="
echo ""

# Step 1: go vet
echo "--- Running go vet ---"
go vet ./...
echo "✓ go vet passed"
echo ""

# Step 2: Build test flags
FLAGS=""
if [ "$RACE" = true ]; then
    FLAGS="$FLAGS -race"
fi
if [ "$VERBOSE" = true ]; then
    FLAGS="$FLAGS -v"
fi
if [ "$COVERAGE" = true ]; then
    FLAGS="$FLAGS -coverprofile=coverage.out"
fi

# Step 3: Run tests
echo "--- Running tests ---"
go test $FLAGS ./...
echo ""
echo "✓ All tests passed"

# Step 4: Coverage report
if [ "$COVERAGE" = true ] && [ -f coverage.out ]; then
    echo ""
    echo "--- Coverage Report ---"
    go tool cover -func=coverage.out
    echo ""
    echo "Coverage file: coverage.out"
    echo "To view HTML: go tool cover -html=coverage.out"
fi

echo ""
echo "=== Done ==="
