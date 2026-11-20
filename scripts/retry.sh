#!/usr/bin/env bash
# Runs a CI step's command once more when it fails (ci.yml: the suites that flake on slow
# runners). A retry that passes still leaves a warning on the run, so flakes stay visible.
"$@" && exit 0
echo "::warning title=Retried::$* failed once and was run again"
"$@"
