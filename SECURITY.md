# Security Policy

## Reporting a Vulnerability

Report suspected vulnerabilities affecting existing code or
customer-accessible deployments using
[GitHub's private vulnerability reporting form](https://github.com/sagemathinc/cocalc-ai/security/advisories/new).
If you cannot use GitHub's private reporting workflow, email
[security@cocalc.ai](mailto:security@cocalc.ai).

Security issues **introduced by an unmerged public pull request itself** are
ordinary pre-merge review findings only if the affected functionality has not
been deployed to a customer-accessible environment. Private development and
testing of that PR do not by themselves disqualify it. Discuss and fix those
issues in the pull request; a private vulnerability report or security advisory
is not required. Merely discovering an issue during PR review does not qualify.
The exception does not apply if the issue was pre-existing, also affects
existing code or a customer-accessible environment, or has already exposed real
credentials or user data. When the cause or scope is uncertain, report
privately first.

Do not disclose vulnerabilities covered by private reporting in a public
issue, discussion, pull request, commit, or branch before coordinating with
the maintainers. Include enough information for us to understand and
reproduce the issue, such as the affected component, impact, reproduction
steps, and any relevant logs or screenshots. Never include credentials,
personal data, or data belonging to other users in a public report or pull
request.

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

Maintainers must handle fixes for privately reported vulnerabilities through
a draft repository security advisory. Pre-merge findings that meet the
exception above can instead be fixed and reviewed in the original public pull
request.

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
