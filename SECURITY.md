# Security policy

Apply New processes candidates' local Claude Code logs and produces a profile that
may be submitted as a job application. That makes two things security-sensitive:
the redaction/privacy pipeline on the candidate's machine, and the public intake
endpoint that receives submissions.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: [GitHub private vulnerability reporting](https://github.com/Play-New/apply-new/security/advisories/new)
  (Security tab → Report a vulnerability).
- Or email **hey@playnew.com** with subject `SECURITY: apply-new`.

We acknowledge within **5 working days** and keep you updated until resolution.
Credit in the fix's release notes is yours if you want it.

## What counts (examples)

- Any path where candidate data leaves the machine without explicit consent
  (bypass of the redaction pipeline, the repoLabel strip, or the submit gate).
- PII surviving redaction into `candidate.json` or the narrative input.
- Log-parsing vulnerabilities (the tool parses untrusted JSONL from disk).
- Intake endpoint issues (injection, auth bypass on the dashboard side, artifact
  upload abuse).
- Anything that lets a profile claim verification it didn't earn (tampering with
  the authenticity/groundedness mechanisms counts — they're trust surfaces).

## Supported versions

The `main` branch. The tool is run from a fresh clone by design, so fixes land on
`main` and there are no maintained release lines.
