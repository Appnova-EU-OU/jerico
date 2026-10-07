# Security policy

## Supported versions

Security fixes are made for the latest released version and the current `main`
branch. Older releases are not supported.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/Appnova-EU-OU/jerico/security/advisories/new).
Do not include exploit details or credentials in public issues. We will
acknowledge reports promptly and coordinate disclosure with the reporter.

## Local threat model

Jerico stores the daemon token in the macOS Keychain. That is convenient
credential storage, not a protection boundary against another process running
as the same macOS user: such a process is inside the local trust boundary and
may read or replace the token. Jerico validates configured daemon endpoints so
mistakes and malformed configuration are rejected rather than silently sending
a token to an unintended destination; this does not defend against code already
running as the user.

## Out of scope

The following are outside this policy's security boundary: a compromised user
account or operating system, malware or scripts executing as the signed-in
user, physical access to an unlocked machine, and credentials deliberately
shared with another person or service. Please still report any unexpected
behaviour that could affect users outside those conditions.
