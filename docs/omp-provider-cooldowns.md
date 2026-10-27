# OMP provider cooldowns

A provider's `retry-after-ms` (milliseconds) or numeric `Retry-After` (seconds) above five minutes,
accompanied by a rate/quota limit, bypasses Workbench's ordinary retry delays. Workbench records the
provider and exact reset deadline, switches immediately to the next configured fallback outside
that cooldown, and resumes the same OMP session. The continuation asks the agent to inspect existing
work before repeating actions. The original task model preference stays unchanged.

Candidates come from OMP's effective `retry.fallbackChains`: model-specific entries, matching
provider/prefix wildcard entries, then the current role's entries. Workbench does not invent a model
route or switch API credentials. Explicit thinking suffixes on fallback entries are preserved.
Quota recovery follows configured chains even when the setting for a final fallback after ordinary
local retries is off; existing OMP overlays already permit usage-limit fallback on those runs.

Cooldowns live in `omp-provider-cooldowns.json` inside Workbench's app data directory. All Workbench
OMP tasks and utility calls share the provider hold, which survives restart. Other providers/local
models can continue. The hold is provider-wide for the current Workbench/OMP configuration; changing
accounts is not automatically detected. Already-running calls are not interrupted. Native fallback
chains are filtered for known blocked providers; a blocked advisor uses its configured fallback or
is disabled for the new run. OMP's own nested work and independently launched terminals remain under
OMP's native recovery policy.

When no eligible configured fallback remains, the task enters the existing persisted rate-limit
hold in Queue. The existing resume scheduler wakes after the earliest relevant provider reset plus
its safety buffer; it does not poll the exhausted provider. Expired holds stop blocking the primary.
A plain 429 with no reset, a short rate limit, or an oMLX connection failure retains normal bounded
retry behavior. Billing/authentication/configuration failures remain permanent failures.

The error text and adapter notices identify the provider, deadline and chosen fallback. Failed
attempt costs/turns are included in the returned phase totals. Ordinary retry messages say
"selected model" rather than assuming every OMP model is local.
