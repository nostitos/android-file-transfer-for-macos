# macOS Release Runbook

The signed release workflow publishes only the exact commit identified by the workflow event's `GITHUB_SHA`. It checks out that SHA in every job, derives the release tag as `v<package.json version>`, and creates or validates that tag against the same source commit. Start the workflow from the commit that contains the intended version; do not change the version through workflow inputs.

## Required workflow inputs

- `signing_identity`: exact Developer ID Application identity reported by `security find-identity -v -p codesigning` after importing the release certificate.
- `csc_certificate_name`: certificate name that `electron-builder` must select from that imported keychain.
- `team_id`: Apple Developer Team ID expected in every signed bundle component.

The `release` environment must provide `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. The certificate identity and `team_id` inputs must match the imported certificate. The workflow removes its temporary keychain after each matrix job.

## Local release requirements

`scripts/release-macos.sh arm64|x64` requires explicit `SIGNING_IDENTITY`, `CSC_CERTIFICATE_NAME`, and `EXPECTED_TEAM_ID`. It also requires one complete notarization method:

- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`; or
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; or
- `APPLE_KEYCHAIN_PROFILE` and, when needed, `APPLE_KEYCHAIN`.

There is no implicit keychain profile. A local operator must select the profile and signing identity deliberately.

## Release checks

The workflow builds and smoke-tests separate native Apple-silicon and Intel bundles. It verifies each DMG before upload and after downloading it from GitHub: Developer ID signature, notarization and stapling, expected team ID, bundle version, macOS minimum version, Mach-O architecture/deployment target, hardened runtime, and the USB entitlement on `mtp-json`.

The published asset set must be exactly these files for the package version: two architecture-specific DMGs, `THIRD_PARTY_SOURCES-<version>.tar.gz`, and `SHA256SUMS.txt`. The downloaded release is rejected if it contains any additional or missing asset.
