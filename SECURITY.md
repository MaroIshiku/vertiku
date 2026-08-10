# Security policy

Please report suspected vulnerabilities privately through GitHub Security Advisories. Do not include real media, credentials, setup secrets, session cookies, or database files in an issue.

Vertiku accepts untrusted uploads. Its media adapters use fixed executable names and validated argument arrays with `shell: false`. Report any path traversal, command injection, cross-account access, or resource-limit bypass as high priority.

Supported security updates target the latest tagged release. Rotate the setup secret after first-run setup and place Vertiku behind HTTPS before remote access.
