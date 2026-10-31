# Missing Twitch participant time

Viewer totals, EventSub messages and Get Chatters are separate observations.
An HTTP 200 response alone does not establish that participant time was collected.

The collector tolerates five minutes of empty responses because Twitch updates
the list with a delay. If chat messages are still arriving, it attempts one
additional paginated sweep using the documented page size 100. Further recovery
sweeps are limited to one per five minutes and share the original timeout and
rate-limit handling. Nonempty snapshots resume ordinary collection automatically.
If the list remains empty, the poll records an unknown gap with reason
`chatters_empty_with_chat` and the connection exposes a presence warning.
Empty quiet chats remain valid. A positive provider `total` with an empty page
cannot establish a complete empty snapshot.

The stream Participants tab also recognizes historical streams with Twitch
messages but no observed presence. It retains messages, shows an explanation,
and renders unavailable Twitch time as a dash. It does not fabricate attendance
from chat messages or rewrite historical facts. Loading and request errors are
shown explicitly instead of an empty participant table.

Read-only production diagnostics compare direct calculations with saved reports
and report the response shape, provider total, alternate page size and canonical
account checks. Credentials and message content must never be printed. These
checks cannot guarantee an upstream service will supply missing observations;
they distinguish collection quality from transport/authentication success.
