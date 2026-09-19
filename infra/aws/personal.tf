# ---- Phase B: the owner's PRIVATE box ----------------------------------------------------------------
# One home for the Episteme library, the focus page and its log, so every device (phone, laptop) is a
# client of the same state instead of holding its own copy. It has NO inbound rule at all: it is reached
# only over the owner's Tailscale network, and administered over Session Manager. It is a different
# machine from the pilot box on purpose: that one serves the public and can be crashed by any client.
#
# Nothing here exists until personal_enabled = true. Before that, put a Tailscale auth key (tagged,
# single-use is fine) into Parameter Store by hand, so it never touches this repository or its state:
#   aws ssm put-parameter --name /arglog/personal/tailscale-authkey --type SecureString --value tskey-auth-...
variable "personal_enabled" { default = false }

data "aws_ami" "ubuntu_arm" {
  count       = var.personal_enabled ? 1 : 0
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
}

resource "aws_security_group" "personal" {
  count       = var.personal_enabled ? 1 : 0
  name        = "arglog-personal"
  description = "owner's private box: no inbound; Tailscale and Session Manager only"
  vpc_id      = "vpc-bc9ed2d9"
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "personal" {
  count              = var.personal_enabled ? 1 : 0
  name               = "arglog-personal-box"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "personal_ssm" {
  count      = var.personal_enabled ? 1 : 0
  role       = aws_iam_role.personal[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "personal" {
  count = var.personal_enabled ? 1 : 0
  name  = "authkey-backups-metrics"
  role  = aws_iam_role.personal[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "arn:aws:ssm:us-east-1:${data.aws_caller_identity.me.account_id}:parameter/arglog/personal/*" },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.backups.arn}/personal/*" },
    { Effect = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = "*", Condition = { StringEquals = { "cloudwatch:namespace" = "ArglogPilot" } } },
  ] })
}
resource "aws_iam_instance_profile" "personal" {
  count = var.personal_enabled ? 1 : 0
  name  = "arglog-personal-box"
  role  = aws_iam_role.personal[0].name
}

resource "aws_instance" "personal" {
  count                       = var.personal_enabled ? 1 : 0
  ami                         = data.aws_ami.ubuntu_arm[0].id
  instance_type               = "t4g.small"
  subnet_id                   = "subnet-f6348caf"
  vpc_security_group_ids      = [aws_security_group.personal[0].id]
  iam_instance_profile        = aws_iam_instance_profile.personal[0].name
  associate_public_ip_address = true # outbound only; the security group admits nothing
  metadata_options { http_tokens = "required" }
  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }
  user_data = <<-BOOT
    #!/bin/bash
    set -e
    snap install aws-cli --classic
    curl -fsSL https://tailscale.com/install.sh | sh
    KEY="$(aws ssm get-parameter --region us-east-1 --name /arglog/personal/tailscale-authkey --with-decryption --query Parameter.Value --output text)"
    tailscale up --authkey "$KEY" --hostname episteme --ssh
  BOOT
  tags = { Name = "arglog-personal", Snapshots = "nightly" }
  lifecycle { ignore_changes = [ami, user_data] }
}
output "personal_instance" { value = var.personal_enabled ? aws_instance.personal[0].id : "not created (personal_enabled = false)" }
