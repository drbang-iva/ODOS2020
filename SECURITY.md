# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting:

1. Go to the **Security** tab on this repository
2. Click **Report a vulnerability**
3. Fill out the form

If you cannot use GitHub's private reporting, email **drbang@ivaeyecare.com** with the subject line `OSOD security report`.

## What to include

- Description of the issue and its impact.
- Steps to reproduce.
- Affected versions / commits.
- Any proof-of-concept code or logs (redact PHI / patient data).
- Your suggested fix, if you have one.

## Response expectations

OSOD is a single-practitioner-led project. Acknowledgement may take up to 7 days. Critical issues affecting deployed practices get priority. Non-critical issues are triaged alongside other work.

You will be credited in the fix commit and release notes unless you ask not to be.

## What is in scope

- Authentication, authorization, SMART v2 token issuance, scope intersection
- Audit logging integrity, tamper-evidence, and DR / backup recovery
- AgentOps governance bypass, agent-action auditability gaps
- AccessPolicy enforcement, role / RBAC bypass
- Bulk Data export and Patient Access API authorization
- Data leakage outside the local practice deployment (telemetry, phone-home, default cloud calls)
- CDS Hooks 2.0.1 service-trust enforcement
- Information Blocking Safety Valve composition
- Dependency vulnerabilities reachable through OSOD code paths

## What is not in scope

- Vulnerabilities in self-hosted Medplum, Postgres, Redis, or Docker. Report those upstream.
- Findings that require physical access to the practice's hardware (those are HIPAA physical safeguards under §164.310, the practice's responsibility).
- Theoretical issues with no reproduction.
- Best-practice suggestions without a concrete vulnerability.

## PHI and patient data

If your report involves any real patient data, **stop and email first**. Do not include PHI in a GitHub vulnerability report or any public artifact.
