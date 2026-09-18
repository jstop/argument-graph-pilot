# ---- the box (imported; never replaced by accident) --------------------------------------------
resource "aws_instance" "pilot" {
  ami                    = "ami-025d99823a4caad37"
  instance_type          = "t3.large"
  subnet_id              = "subnet-f6348caf"
  key_name               = "credential-pilot"
  vpc_security_group_ids = [aws_security_group.pilot.id]
  iam_instance_profile   = aws_iam_instance_profile.pilot.name
  tags                   = { Name = "credential-pilot", Snapshots = "nightly" }
  lifecycle {
    prevent_destroy = true # it holds every member's identifier; see RUNBOOK §4
    ignore_changes  = [ami, user_data, user_data_base64, root_block_device]
  }
}

resource "aws_security_group" "pilot" {
  name        = "credential-pilot"
  description = "credential pilot: 80/443 public, 22 from operator"
  vpc_id      = "vpc-bc9ed2d9"
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  dynamic "ingress" {
    for_each = var.ssh_cidr == "" ? [] : [var.ssh_cidr]
    content {
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle { ignore_changes = [description] }
}

resource "aws_eip" "pilot" {
  tags   = { Name = "credential-pilot" }
  domain = "vpc"
  lifecycle { prevent_destroy = true } # every DNS record and every witness OOBI points here
}
resource "aws_eip_association" "pilot" {
  allocation_id = aws_eip.pilot.id
  instance_id   = aws_instance.pilot.id
}

data "aws_route53_zone" "main" { name = var.zone_name }
resource "aws_route53_record" "host" {
  for_each = toset(local.hosts)
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "${each.key}.${var.domain}"
  type     = "A"
  ttl      = 60
  records  = [aws_eip.pilot.public_ip]
}

# ---- what the box may do in AWS: be reached by Session Manager, WRITE backups, report metrics ------
resource "aws_iam_role" "pilot" {
  name               = "arglog-pilot-box"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.pilot.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "pilot" {
  name = "backups-and-metrics"
  role = aws_iam_role.pilot.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    # Put only. A compromised box cannot read or delete earlier backups; versioning keeps what it overwrites.
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.backups.arn}/box/*" },
    { Effect = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = "*", Condition = { StringEquals = { "cloudwatch:namespace" = "ArglogPilot" } } },
  ] })
}
resource "aws_iam_instance_profile" "pilot" {
  name = "arglog-pilot-box"
  role = aws_iam_role.pilot.name
}
