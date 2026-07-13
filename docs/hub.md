# Paseo Hub relationship

Paseo Hub is an explicit opt-in connection from one Paseo daemon to one Hub. Running a daemon does
not register it with a Hub. The relationship begins only when a user runs
`paseo hub connect <url> --token <token>` from the daemon machine.

## Connection and authority

The daemon enrolls over HTTP(S), then opens and maintains a direct outbound WebSocket to the Hub.
The Hub never discovers or acquires the daemon through Paseo's relay. The relay remains an optional
encrypted path for normal Paseo clients and has no role in Hub enrollment, authentication, dispatch,
or reconnects.

The daemon persists a relationship ID and private connection credential before enrollment. The
relationship is independent of its current transport, so a future transport can replace the direct
WebSocket without pairing again. The current foundation supports one Hub relationship per daemon.

Only a trusted session arriving through a server-observed local, non-browser daemon transport may
run the `hub.relationship.connect`, `hub.relationship.get_status`, and
`hub.relationship.disconnect` RPCs. Remote, relay, browser-origin, and Hub sessions cannot manage
the relationship. A hello message's `clientType` is descriptive and grants no authority.

## Hub session scope

An accepted Hub socket receives a dedicated `HubSession`, not the daemon's general client `Session`.
Its inbound allowlist contains only the `hub.*` operations required for Hub-owned execution, and its
outbound events include only agents owned by that relationship. Unrelated local agents, browser
control, retained client sessions, binary channels, and ordinary daemon broadcasts are outside the
Hub surface.

Each Hub create carries an execution ID. The daemon stores that ID with the agent's relationship
owner before acknowledging creation. Duplicate or replayed creates for the same relationship and
execution resolve to the same durable agent. On reconnect or daemon restart, Hub reconciliation
reads that stored association and returns current state; transient stream frames are not durably
replayed.

While a Hub-owned initial turn is running, the daemon also keeps a relationship-owned resume intent
containing that prompt and a stable message ID. Provider session resume restores conversation state
but does not generically continue work interrupted by daemon shutdown, so reconciliation reloads the
same agent and replays only that armed turn. A normal socket reconnect or duplicate create sees the
live run and does not replay it. Completion, failure, cancellation, archive, or any persisted state
other than `running` disarms the intent.

Hub creates use the same agent creation path as trusted clients. They may select any existing
worktree target shape and may request `autoArchive`. Worktree creation and terminal auto-archive use
the shared workspace-aware lifecycle policy; Hub does not have a second launch or cleanup path.

## Disconnect and revocation

Normal socket loss reconnects the active relationship with bounded exponential backoff and jitter.
Daemon restart loads the same relationship and credential and reconnects without another enrollment
ceremony.

Hub authentication rejection or close code `4403` permanently revokes the local relationship. The
daemon deletes its credential, stops reconnecting, and retains only the relationship ID, Hub origin,
scopes, and a sanitized reason for status reporting.

`paseo hub disconnect` disables socket reconnect before requesting remote revocation. If the Hub is
offline, the daemon persists `disconnecting` and retries revocation across daemon restarts without
opening a Hub socket. `--force` removes local authority immediately and warns that remote revocation
may still be pending.

## Cross-repository dependency

The consumer implementation lives in Paseo Cloud and depends on the Paseo protocol, client, server,
and CLI package versions that expose this Hub surface. Cross-repository end-to-end verification must
install those packages together and exercise the real daemon, CLI, direct WebSocket, Cloud service,
and Postgres. A Paseo Cloud change must not assume unpublished local package contents.
