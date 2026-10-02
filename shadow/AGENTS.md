# Proof of Reason shadow-audit agents

The sampling frame for A1, under docs/PREREG.md Amendment 1. An agent is listed before any of its
actions is audited. Each row gives a listing time in UTC. The hash of the commit that adds the row
is posted publicly, with a visible time, before that listing time, and the commit is public on
GitHub by the next read. An action counts only if both the transaction and the statement
explaining it came after the agent's listing time. From then on, the agent's publicly explained
actions are audited in posting order, none skipped. An operator log lists the period it covers
here before the log is read.

Type is one of: vault allocator, trader, other. Every A1 read reports its counts by type.

Append-only: add rows in a new commit and never edit or remove one. A mistake is fixed by a new
row, which counts from its own listing time.

| Listed (UTC) | Agent | Type | Wallet | Chain | Where it explains its actions |
| --- | --- | --- | --- | --- | --- |
