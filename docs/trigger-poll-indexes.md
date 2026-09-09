# Trigger poll indexes

Queue and Durable Object alarm polling are regular SQLite reads. The broker and
standalone runtime both create these additive indexes when they open a store:

```sql
CREATE INDEX IF NOT EXISTS mq_due ON mq (queue, dead, visible_at);
CREATE INDEX IF NOT EXISTS do_alarm_due ON do_alarm (at);
```

`mq_due` matches the queue partition, excludes dead messages, and keeps the
remaining rows in the existing `visible_at` delivery order. `do_alarm_due`
matches the global earliest-due alarm scan. Neither index changes acknowledgement,
retry, batch size, or alarm claim semantics.

Existing SQLite files are upgraded in place by `CREATE INDEX IF NOT EXISTS`.
There is no table rewrite or data migration. Broker resource-backed queue files,
the broker deployment store, and standalone `store.sqlite` all receive the
relevant index at open.

## Repeatable measurement

Run `bun bench/trigger-poll.ts`. It constructs deterministic fixtures: empty,
large, mostly-delayed, and mostly-dead queues with 60,000 queue rows total, plus
a 50,000-row alarm set. It prints `EXPLAIN QUERY PLAN`, mean query time over 250
polls, the time for a 5,000-message write transaction, and final database size
for schemas with and without the indexes.

The script is the record of query plans and measurements, rather than a fixed
number that would misrepresent another disk, SQLite version, or CPU. Its output
is deliberately not a throughput guarantee. The regression tests assert that
SQLite selects `mq_due` and `do_alarm_due` for the production due-work queries,
and that an existing broker and resource database gain the indexes safely.

## Local reference run

One local run on 2026-09-10 produced the following result. Times are mean
milliseconds per read over 250 repetitions; the empty queue is the idle-poll
CPU proxy. Database size and write time are for the whole fixture plus one
5,000-message transaction. They document the tested trade-off, not a portable
speed claim.

| Fixture | Before plan | Before ms | After plan | After ms |
| --- | --- | ---: | --- | ---: |
| Empty queue | `SCAN mq`, temp sort | 2.180 | `SEARCH mq USING INDEX mq_due` | 0.007 |
| Large queue | `SCAN mq`, temp sort | 2.893 | `SEARCH mq USING INDEX mq_due` | 0.006 |
| Mostly delayed | `SCAN mq`, temp sort | 2.563 | `SEARCH mq USING INDEX mq_due` | 0.007 |
| Mostly dead | `SCAN mq`, temp sort | 2.529 | `SEARCH mq USING INDEX mq_due` | 0.007 |
| Large alarm set | `SCAN do_alarm`, temp sort | 1.417 | `SEARCH do_alarm USING INDEX do_alarm_due` | 0.005 |

The baseline database was 7,000,064 bytes and wrote 5,000 rows in 6.005 ms.
The indexed database was 9,457,664 bytes and wrote the same transaction in
8.119 ms. The additional write and storage cost is intentional and measured.
