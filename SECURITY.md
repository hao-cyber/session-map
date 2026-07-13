# Security policy

Maintrail reads local AI-agent transcripts and can explicitly focus, resume, or
send text to a terminal. Reports involving capability-token bypass, origin
validation, path traversal, transcript mutation, command injection, or unsafe
model operations are security-sensitive.

Please report vulnerabilities privately through GitHub Security Advisories.
Do not include real transcript contents, capability tokens, usernames, or local
paths in a public issue.

The supported release line is the latest tagged version. Maintrail binds only
to `127.0.0.1`; exposing it through a proxy is outside the threat model.
