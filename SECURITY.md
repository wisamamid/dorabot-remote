# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please email wisam@xische.com instead of using the public issue tracker. Please do not open public issues for security vulnerabilities.

## Supported Versions

Only the latest version of dorabot-remote receives security updates and patches.

## Security Model

dorabot-remote is built on several core security principles:

- **E2E Encryption**: All communication between device and host is end-to-end encrypted.
- **Blind Relay**: The relay server cannot inspect or access application data.
- **Per-Device Scopes**: Each paired device operates with independently configured permissions.
- **Pairing Confirmation**: New device pairings require explicit approval on the Mac.
- **Shared-Folder Allowlist**: Only explicitly allowlisted folders are accessible; nothing is shared by default.
- **Audit Log**: All access and operations are logged for security auditing.

For implementation details, see the README.md and documentation.
