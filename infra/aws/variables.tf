variable "domain"      { default = "pilot.joshautomates.com" }
variable "zone_name"   { default = "joshautomates.com." }
variable "alert_email" { default = "" } # where alarms go; empty = topic exists, nobody is told (RUNBOOK §1c)
variable "alert_sms"   { default = "" } # E.164, e.g. +15551234567
variable "ssh_cidr"    { default = "" } # empty = port 22 closed; access is AWS Session Manager
locals {
  hosts = concat(["claims", "issuer", "keria", "keria-ext", "keria-boot"], [for i in range(6) : "witness-${i}"])
}
