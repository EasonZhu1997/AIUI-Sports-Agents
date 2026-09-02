# Source approval records

This directory holds maintainer-approved, machine-readable copies of application source-distribution approvals.

The active approvals for AISmartRun, AIBike, and AISmartRower bind each public application snapshot to its legal licensor, contributor-rights review, third-party-rights review, baseline revision, and deterministic content manifest. The Git-tracked record in this Hub path is authoritative; each byte-identical copy under `apps/<project-id>/` is checked against it, so an application directory cannot approve itself merely by changing its local copy.

This directory name does not itself create GitHub protection. Before any project moves to `ready`, enable and verify a repository ruleset or branch protection that requires pull requests, approval, and CODEOWNERS review, with an intentional administrator-bypass policy.
