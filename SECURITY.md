# Security Policy

## Reporting a Vulnerability

Please report suspected security vulnerabilities using
[GitHub's private vulnerability reporting form](https://github.com/sagemathinc/cocalc-ai/security/advisories/new).
If you cannot use GitHub's private reporting workflow, email
[security@cocalc.ai](mailto:security@cocalc.ai).

Do not disclose a suspected vulnerability in a public issue, discussion, pull
request, commit, or branch before coordinating with the maintainers. Include
enough information for us to understand and reproduce the issue, such as the
affected component, impact, reproduction steps, and any relevant logs or
screenshots. Do not include credentials, personal data, or data belonging to
other users.

We will coordinate disclosure with the reporter after a fix or mitigation is
available. We do not offer a bug bounty program.

## Maintainer Workflow

### Unreleased Pull Requests

Findings introduced solely by an unmerged, unreleased pull request should be
fixed and reviewed in that pull request using the normal development workflow.
Do not create a private security advisory or temporary private fork for these
findings. This includes agents reviewing their own in-progress changes.

Before applying this exception, confirm that the vulnerable code is not already
present in a released version or a deployment serving users. Running the PR in
the developer's own isolated test environment does not make it released. An
unmerged PR alone does not establish the scope: the same issue may exist in
released code, or the PR may already be serving customers. If released or
deployed users are affected, or that is uncertain, use the private workflow
below and coordinate with maintainers.

### Released or Deployed Code

Maintainers must handle non-public security fixes through a draft repository
security advisory:

1. Create or accept a draft advisory under the repository's Security tab.
2. Add only the collaborators needed to investigate and review the issue.
3. Create the advisory's temporary private fork and develop the fix there.
4. Open the pull request from the advisory page. Do not push the fix or its
   details to the public repository before deployment.
5. Validate locally because GitHub Actions and other integrations do not run
   on temporary private forks.
6. Merge the advisory pull request, deploy the mitigation promptly, and only
   then publish the advisory or otherwise disclose the vulnerability.

See GitHub's documentation on
[collaborating in a temporary private fork](https://docs.github.com/code-security/security-advisories/working-with-repository-security-advisories/collaborating-in-a-temporary-private-fork-to-resolve-a-repository-security-vulnerability).
