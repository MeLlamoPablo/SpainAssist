# The IAM user Terraform manages AWS with (aws_access_key_id/aws_secret_access_key in
# terraform.tfvars). It may only manage what dns.tf declares, and it cannot change its own
# permissions, so changes to this file need an admin key for one apply:
#
#   ./tf.sh apply -var-file=<admin.tfvars>   # aws_access_key_id + aws_secret_access_key
#
# Route 53 Domains has no resource-level permissions: the domain statements apply to every
# domain in the account. They grant only reads and name server updates, and an explicit deny
# blocks deleting, transferring or letting any domain lapse.

resource "aws_iam_user" "terraform" {
  name = "${var.name}-terraform"
}

resource "aws_iam_access_key" "terraform" {
  user = aws_iam_user.terraform.name
}

resource "aws_iam_user_policy" "terraform" {
  name   = "dns"
  user   = aws_iam_user.terraform.name
  policy = data.aws_iam_policy_document.terraform.json
}

data "aws_iam_policy_document" "terraform" {
  statement {
    sid = "HostedZone"
    actions = [
      "route53:GetHostedZone",
      "route53:ListTagsForResource",
      "route53:ChangeTagsForResource",
      "route53:ListResourceRecordSets",
      "route53:ChangeResourceRecordSets",
    ]
    resources = [aws_route53_zone.main.arn]
  }

  statement {
    sid       = "Changes"
    actions   = ["route53:GetChange"]
    resources = ["arn:aws:route53:::change/*"]
  }

  statement {
    sid = "Domain"
    actions = [
      "route53domains:GetDomainDetail",
      "route53domains:ListTagsForDomain",
      "route53domains:GetOperationDetail",
      "route53domains:UpdateDomainNameservers",
      "route53domains:EnableDomainAutoRenew",
    ]
    resources = ["*"]
  }

  # Refreshing this file's resources.
  statement {
    sid = "ReadSelf"
    actions = [
      "iam:GetUser",
      "iam:GetUserPolicy",
      "iam:ListAccessKeys",
    ]
    resources = [aws_iam_user.terraform.arn]
  }

  statement {
    sid    = "KeepDomains"
    effect = "Deny"
    actions = [
      "route53domains:DeleteDomain",
      "route53domains:TransferDomain",
      "route53domains:TransferDomainToAnotherAwsAccount",
      "route53domains:DisableDomainAutoRenew",
      "route53domains:DisableDomainTransferLock",
      "route53domains:UpdateDomainContact",
      "route53:DeleteHostedZone",
    ]
    resources = ["*"]
  }
}
