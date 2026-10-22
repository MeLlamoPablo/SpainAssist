# --- App release signing: GitHub Actions secrets for .github/workflows/release.yml -------
#
# macOS builds are signed with the Developer ID Application certificate and notarized with an
# App Store Connect API key; the Windows Store MSIX is submitted with an Entra app. Both files live in secrets/, committed encrypted (git-crypt,
# .gitattributes); their non-file values are in terraform.tfvars.

locals {
  release_secrets = {
    # electron-builder imports the .p12 from base64 (`CSC_LINK`) into a temporary keychain.
    CSC_LINK         = filebase64("${path.module}/secrets/developer-id.p12")
    CSC_KEY_PASSWORD = var.apple_signing_p12_password
    # notarytool needs a file: release.yml writes this to disk and points APPLE_API_KEY at it.
    APPLE_API_KEY_P8 = file("${path.module}/secrets/AuthKey_${var.apple_api_key_id}.p8")
    APPLE_API_KEY_ID = var.apple_api_key_id
    APPLE_API_ISSUER = var.apple_api_issuer_id
  }

  # Android signs with the existing Play App Signing upload key (PKCS12, alias upload).
  android_secrets = var.android_upload_keystore_password == "" ? {} : {
    SA_UPLOAD_KEYSTORE_BASE64   = filebase64("${path.module}/secrets/android-upload.jks")
    SA_UPLOAD_KEYSTORE_PASSWORD = var.android_upload_keystore_password
    SA_UPLOAD_KEY_ALIAS         = "upload"
    SA_UPLOAD_KEY_PASSWORD      = var.android_upload_keystore_password
  }

  # The service account must also be granted app access in Play Console. Keep the JSON with
  # the other git-crypt secrets; omit it until that one-time setup is complete.
  play_secrets = fileexists("${path.module}/secrets/google-play-service-account.json") ? {
    PLAY_SERVICE_ACCOUNT_JSON = file("${path.module}/secrets/google-play-service-account.json")
  } : {}

  # The `store` job submits the Store MSIX to Partner Center with these, or warns without them.
  store_secrets = var.partner_center_client_id == "" ? {} : {
    PARTNER_CENTER_TENANT_ID     = var.partner_center_tenant_id
    PARTNER_CENTER_CLIENT_ID     = var.partner_center_client_id
    PARTNER_CENTER_CLIENT_SECRET = var.partner_center_client_secret
    PARTNER_CENTER_SELLER_ID     = var.partner_center_seller_id
  }
}

resource "github_actions_secret" "release" {
  # Only secret names are public; the optional Android map depends on a sensitive password.
  for_each = nonsensitive(toset(keys(merge(local.release_secrets, local.store_secrets, local.android_secrets, local.play_secrets))))

  repository  = split("/", var.github_repository)[1]
  secret_name = each.key
  value       = merge(local.release_secrets, local.store_secrets, local.android_secrets, local.play_secrets)[each.key]
}
