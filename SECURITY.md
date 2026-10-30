# Security policy

## Release signing

Release tags `v*` are signed with the project SSH signing key:

- fingerprint: `SHA256:RKtM0n6ob0U7GcFKq9FVum3BifnM/pPvaZf+Vsn8OxU`
- public key: [`security/release-signing-key.pub`](security/release-signing-key.pub)

Verify a tag:

```bash
git -c gpg.ssh.allowedSignersFile=security/allowed_signers verify-tag v0.1.0
```

`security/allowed_signers` contains:

```text
lucrium-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILBugtb8eBzKbNrkbJ1GH9h0NPIGtm3LTODxg6iprSGW lucrium-release
```

Sign a future release tag:

```bash
git tag -s v0.2.0 -m "Lucrium Panel 0.2.0"
git push origin v0.2.0
```

Only maintainers should create `v*` tags; GitHub tag rulesets block updates and
deletions of existing release tags. Release all three repositories with the same
signed tag name in this order: `lucrium-protocol` → `lucrium-worker` →
`lucrium-panel`; the panel release workflow checks out the protocol tag and
verifies both signatures.

## Windows executable

Release assets include `SHA256SUMS` and a Sigstore bundle. The build workflow
signs the executable and checksums keylessly with cosign/OIDC. Verify before
running:

```powershell
Get-FileHash .\Lucrium.exe -Algorithm SHA256
cosign verify-blob `
  --bundle .\Lucrium.exe.sigstore.json `
  --certificate-identity-regexp 'https://github.com/nechel12/lucrium-panel/.github/workflows/release.yml@refs/tags/.*' `
  --certificate-oidc-issuer https://token.actions.githubusercontent.com `
  .\Lucrium.exe
```

## Reporting

Please report vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability") rather than opening a public issue.
