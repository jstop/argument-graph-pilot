#!/usr/bin/env bash
# Every 5 minutes from cron: how full the root disk is, for the CloudWatch alarm.
set -euo pipefail
aws cloudwatch put-metric-data --namespace ArglogPilot --metric-name DiskUsedPercent --unit Percent \
  --value "$(df --output=pcent / | tail -1 | tr -dc 0-9)"
