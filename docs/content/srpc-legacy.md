# Legacy SRPC Protocol

Use this reference when maintaining v1–v4 peers or migrating clients with untyped protobuf envelopes. See the main [SRPC guide](./srpc.md) for setup and [protocol v5](./srpc.md#protocol-v5).

## Versions and Query Fields

Legacy clients identify the protocol with `pv`. The server accepts `_v` when `pv` is absent. Set `defaultUnspecifiedProtocolVersion` to `1`, `2`, or `3` only while migrating a client that omits the version. The server otherwise requires an explicit version.

| Version | HMAC format | Replay token | Connection behavior                                                |
| ------- | ----------- | ------------ | ------------------------------------------------------------------ |
| v1      | Legacy      | `id`         | Replaces the active connection with the same client ID.            |
| v2      | Legacy      | `id`         | Requires supersede to replace an active connection.                |
| v3      | Canonical   | `nonce`      | Adds signed capabilities. Earlier Node clients used v3 by default. |
| v4      | Canonical   | `nonce`      | Adds request acknowledgments to the v3 behavior.                   |

An explicit `pv=1` selects v1 behavior. Use it only for a legacy client that intentionally relies on replacing the existing connection with the same `clientId`.

The v3 and v4 Node clients send `pv`, `appv`, `ts`, `nonce`, `aud`, `id`, `cid`, and `signature` for HMAC authentication. They can also send `cap` for capabilities and `supersede=1` to replace an existing connection. The legacy alias `_supersede` applies when `supersede` is absent.

Custom query fields become `stream.meta`. The server normalizes `m--<key>` to `<key>` and gives an unprefixed field precedence if both appear.

## Authentication and Replay

V1 and v2 sign the literal `1`, then `appv`, `ts`, `id`, and `cid`, each followed by a newline. The server consumes the connection ID once per client as the replay token. It ignores the capability field for these versions.

V3 and v4 use the canonical HMAC format. The signature binds the request path, audience, advertised protocol version, capabilities, and normalized metadata along with the app version, timestamp, connection ID, client ID, nonce, and supersede flag. The server checks the audience and consumes the nonce separately from the connection ID.

Legacy mTLS handshakes can omit the HMAC credentials. A custom authorizer receives the certificate-derived identity in `query.cid`.

## Untyped PingPong Compatibility

A missing or `UNSPECIFIED` `PingPong.type` selects the legacy client sequence. The client answers the first ping, connects on the next ping, and then uses subsequent pings to refresh liveness. If untyped liveness messages precede a typed handshake, the client answers the first untyped ping and waits for the next untyped ping or `ACTIVATED`. The DevConsole browser client preserves its first-ping connection behavior with untyped servers.

The server answers legacy untyped or `UNSPECIFIED` messages with `PONG` after activation, regardless of the `reply` flag.

Old protobuf decoders ignore the optional `PingPong.type` field. Current decoders accept empty messages. An old server codec also omits the field on encode, so upgrading TSF alone can still produce untyped pings. Add the enum and optional field to your proto and regenerate with `tsf-gen-proto` to send and receive typed messages. Existing peers can keep using the untyped handshake during the upgrade. Custom codecs must accept or ignore the field.

## Request Acknowledgments

Earlier versions of `SrpcClient` could set `protocolVersion: 4` when both envelope codecs preserved `requestAck` and the server recognized v4. Versionless clients cannot negotiate acknowledgments through `defaultUnspecifiedProtocolVersion`.

V1–v3 retain their original timeout behavior even when `disconnectOnRequestTimeout` is enabled. See [Errors And Timeouts](./srpc.md#errors-and-timeouts) for how the policy applies when a connection negotiates receipts.
