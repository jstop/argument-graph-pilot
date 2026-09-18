# Everything AWS the pilot stands on. The box, its firewall, address and DNS
# were made by hand for demo2 (its RUNBOOK §9) and are IMPORTED here, not
# recreated. State: a private, versioned, encrypted bucket (made once by
# hand, RUNBOOK §1c), with S3-native locking.
terraform {
  required_version = ">= 1.10"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.80" } }
  backend "s3" {
    bucket       = "arglog-pilot-tfstate-523888557587"
    key          = "pilot/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags { tags = { Project = "argument-graph-pilot", ManagedBy = "terraform" } }
}
