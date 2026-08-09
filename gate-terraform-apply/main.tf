# A deliberately harmless config so the approval ceremony can be run end to end with no cloud
# credentials and nothing to clean up. Replace it with your real infrastructure; the gating in
# gate-apply.sh does not care what the plan contains.
terraform {
  required_version = ">= 1.5"
}

variable "environment" {
  type        = string
  default     = "prod-eu-1"
  description = "Bound into the approval as the target, so an approval for staging cannot be spent on production."
}

resource "local_file" "release_marker" {
  filename = "${path.module}/.terraform-gated-apply-ran"
  content  = "applied for ${var.environment}\n"
}
