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

Maintainers fix vulnerabilities in released or deployed code in the private
repository `sagemathinc/cocalc-ai-private`, following
[`src/scripts/security/README.md`](src/scripts/security/README.md). Pre-merge
findings that meet the exception above can instead be fixed and reviewed in
the original public pull request.

1. Start a `security/*` branch from public main with
   `src/scripts/security/private-fix.sh start <topic>`, and open a pull
   request in the private repository. CI and review run there.
2. Add only the collaborators needed to investigate and review the issue.
3. Do not push the fix or its details to the public repository before
   deployment. The pre-push guard (`src/scripts/security/install-hooks.sh`)
   refuses such pushes.
4. Deploy the fix from a release branch that merges the private branch, then
   disclose it promptly with `src/scripts/security/disclose.sh`. Self-hosted
   installs are built from the public repository, so they only get the fix
   once it is disclosed.
5. A draft repository security advisory can still track a private report,
   credit the reporter and request a CVE. Publish it after disclosure. Its
   temporary private fork is not used for development: GitHub Actions do not
   run on it, and a release often needs several fixes together.
