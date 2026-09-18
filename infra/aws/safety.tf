# ---- backups: bucket for the nightly file-level backup (volumes + the three secrets) -------------------
data "aws_caller_identity" "me" {}
resource "aws_s3_bucket" "backups" {
  bucket = "arglog-pilot-backups-${data.aws_caller_identity.me.account_id}"
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "keep-35-days-then-monthly-firsts-are-on-you"
    status = "Enabled"
    filter { prefix = "box/" }
    expiration { days = 35 }
    noncurrent_version_expiration { noncurrent_days = 35 }
  }
}
resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Sid = "TlsOnly", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}

# ---- nightly whole-disk snapshots of anything tagged Snapshots=nightly (the box), kept 14 days ---------
resource "aws_iam_role" "dlm" {
  name               = "arglog-pilot-dlm"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "dlm.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}
resource "aws_dlm_lifecycle_policy" "nightly" {
  description        = "arglog pilot nightly snapshot of the box 14 kept"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"
  policy_details {
    resource_types = ["INSTANCE"]
    target_tags    = { Snapshots = "nightly" }
    schedule {
      name = "nightly"
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["08:30"]
      }
      retain_rule { count = 14 }
      copy_tags = true
      tags_to_add = { Project = "argument-graph-pilot" }
    }
  }
}

# ---- someone gets told: public endpoints, disk, and whether last night's backup happened ------------------
resource "aws_sns_topic" "alerts" { name = "arglog-pilot-alerts" }
resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
resource "aws_sns_topic_subscription" "sms" {
  count     = var.alert_sms == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "sms"
  endpoint  = var.alert_sms
}

locals {
  checks = {
    argument-site = { host = "claims", path = "/healthz", search = "\"ok\":true" }
    issuer        = { host = "issuer", path = "/healthz", search = "\"ok\":true" }
    keria         = { host = "keria-ext", path = "/spec.yaml", search = "openapi" }
    witness-0     = { host = "witness-0", path = "/oobi", search = null }
  }
}
resource "aws_route53_health_check" "public" {
  for_each          = local.checks
  fqdn              = "${each.value.host}.${var.domain}"
  type              = each.value.search == null ? "HTTPS" : "HTTPS_STR_MATCH"
  search_string     = each.value.search
  port              = 443
  resource_path     = each.value.path
  request_interval  = 30
  failure_threshold = 3
  tags              = { Name = "arglog-${each.key}" }
}
resource "aws_cloudwatch_metric_alarm" "public" {
  for_each            = local.checks
  alarm_name          = "arglog-${each.key}-down"
  alarm_description   = "https://${each.value.host}.${var.domain}${each.value.path} is failing from outside. RUNBOOK §5."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.public[each.key].id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "disk" {
  alarm_name          = "arglog-box-disk-over-80-percent"
  alarm_description   = "The box's root disk is filling (docker images, KERIA's databases, logs)."
  namespace           = "ArglogPilot"
  metric_name         = "DiskUsedPercent"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "backup" {
  alarm_name          = "arglog-box-backup-missing"
  alarm_description   = "No successful file-level backup reported in the last 26 hours. ops/box/backup.sh, ~/arglog-backup.log."
  namespace           = "ArglogPilot"
  metric_name         = "BackupSucceeded"
  statistic           = "Sum"
  period              = 93600
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

output "backup_bucket" { value = aws_s3_bucket.backups.id }
output "alerts_topic"  { value = aws_sns_topic.alerts.arn }
