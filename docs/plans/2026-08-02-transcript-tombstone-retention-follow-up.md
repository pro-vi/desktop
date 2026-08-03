# Transcript tombstone retention follow-up

Status: deferred storage-contract work identified while resolving review finding F13.

The V0 live-state file now bounds each active or forgotten source to 64 retained terminal attempts. A persisted `historyBaseSnapshot` carries the latest complete snapshot from the compacted prefix, so restart validation can still prove every retained `changed` value and the source's current latest snapshot. Open attempts are never compacted. Forgetting remains recoverable because the tombstone retains the complete source projection, its base snapshot, its recent terminal attempts, and the immutable blobs.

The remaining limit is the number of recoverable tombstones. `deletedSources` is intentionally not evicted: silently dropping an older tombstone would make the returned `recoverable: true` promise false. Enough forget operations can therefore still approach the 16 MiB state-file ceiling, at which point a new forget fails safely without deleting the active source.

Resolving that limit requires a storage-contract change, not a retention constant. The preferred follow-up is one private atomic tombstone file per opaque `local-trash/<id>` recovery location, written durably before removing the active source. A bounded index must support restart enumeration and idempotent replay. User-facing restore and permanent-purge operations need explicit confirmation contracts before any tombstone can be removed.

Acceptance for that follow-up must prove: crash before and after active-source removal; restart enumeration; restore without changing the provider conversation; confirmed permanent purge; no tombstone eviction; private `0700`/`0600` modes; and no paths or transcript content in logs or errors.
