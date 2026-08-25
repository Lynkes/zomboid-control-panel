# Conflict and Scope Resolution

## Coordinator-Owned Hunk Collision

1. Integrate lower-level dependency first.
2. Rerun its focused and full gates.
3. Rebase/re-plan the dependent hunk against the accepted result.
4. The dependent package owner regenerates parity evidence.
5. Never combine two independently authored versions of route registration, package manifests, flags, or DB composition by textual preference.

## Scope Expansion Request

A package owner must stop and submit:

```text
Work package:
Requested new paths:
Why current contract cannot be met:
Alternatives considered:
Dependency/ownership conflicts:
Risk/rollback impact:
Recommended action:
```

Coordinator chooses: deny, amend ownership, split a new package, or block pending user decision.

## Contract Conflict

If implementation requires changing a V1 endpoint, response, status, Socket.IO event, or UI workflow:

- record exact old/new fixture diff;
- identify every client/extension/updater consumer;
- propose an adapter-compatible option first;
- stop until coordinator and user approve an explicit contract-version decision.

## Data Authority Conflict

If two stores/transports can write the same entity:

- disable the new writer;
- preserve current authority;
- record the conflicting code paths and lock scope;
- create/modify an authority ADR before resuming.

## Test Conflict

Tests are contract evidence. Do not weaken an assertion to accept new behavior unless an approved ADR/contract fixture records the intentional change.
