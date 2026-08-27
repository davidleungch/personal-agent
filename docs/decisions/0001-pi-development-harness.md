Decision:
Use a project-owned DevelopmentHarness abstraction for Phase 2.

Initial implementation:
Pi Coding Agent SDK.

Why:
Pi provides coding-agent loop/session/context/compaction/tool mechanics,
while the platform retains durable state, authority, sandbox policy,
review policy, merge policy, and deployment policy.

Pi does not replace the Phase 1 ACT runtime.

Pi sessions are task-local execution state only.

Autonomous development runs must be externally sandboxed.