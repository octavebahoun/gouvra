# Automations, webhooks and connectors

Agents and workflows can start on their own: on a **schedule**, or when another system calls a
**webhook**. With **connectors**, they can act on other systems (post to Slack or Discord, open a
GitHub issue, send a signed event to your own endpoint).

- [Schedules](#schedules)
- [Inbound webhooks](#inbound-webhooks)
  - [Signing a delivery](#signing-a-delivery)
  - [Idempotency and retries](#idempotency-and-retries)
  - [GitHub webhooks](#github-webhooks)
  - [From payload to input](#from-payload-to-input)
- [Connectors](#connectors)
  - [Verifying Gouvra's outgoing events](#verifying-gouvras-outgoing-events)
- [Limits and failure handling](#limits-and-failure-handling)

## Schedules

A schedule runs an agent, or the published version of a workflow, with a fixed input.

- **Cron, five fields**: `minute hour day-of-month month day-of-week`, e.g. `0 9 * * 1-5` (09:00 on
  weekdays), `*/15 * * * *` (every 15 minutes), or `@hourly`, `@daily`, `@weekly`, `@monthly`.
- **Time zone**: any IANA name (`Europe/Paris`, `America/New_York`). Times follow daylight saving
  time: `0 9 * * *` in `Europe/Paris` is 07:00 UTC in summer and 08:00 UTC in winter.
- **Overlap**: by default a tick is *skipped* while the run started by the previous one is still in
  progress, so slow runs never pile up. Choose *allow* to start every tick anyway.
- **Missed ticks** (the worker was stopped): the schedule fires once when the worker comes back,
  marked as late, then continues at its next planned time. Ticks are never replayed in a burst.
- **Run now** starts the schedule immediately (with its input or another one), as you.

## Inbound webhooks

A webhook has a public address — `https://<your host>/api/v1/hooks/<token>` — and a **signing
secret** shown once when it is created (store it in the sending system; you can replace it, after
which the old one stops working at once).

Every delivery must be signed. Unsigned, wrongly signed or stale requests are refused with
`401` and appear in the automation's deliveries, so you can see what went wrong.

| Answer | Meaning |
|---|---|
| `202 Accepted` | The run started (`execution_id` or `workflow_run_id` in the body). |
| `200 OK` with `"duplicate": true` | Already received: the outcome of the first delivery, no new run. |
| `401` | Missing, invalid or stale signature (`code`: `missing_signature`, `invalid_signature`, `stale_signature`). |
| `404` | No webhook at this address. |
| `409` | The automation is paused. |
| `413` / `429` | Payload too large (256 KB by default) / too many deliveries (60 per minute per webhook). |

### Signing a delivery

The `Gouvra-Signature` header carries a timestamp and an HMAC-SHA256 of `"<timestamp>.<raw body>"`:

```
Gouvra-Signature: t=1760180000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

Signatures older than 5 minutes are refused, so a captured request cannot be replayed later.
Several `v1=` values may be sent (one per secret), which helps while you switch secrets.

**Python**

```python
import hashlib, hmac, json, time, urllib.request

secret = "gvwhsec_..."
body = json.dumps({"ticket": {"id": 42, "title": "Refund"}}).encode()
timestamp = int(time.time())
digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
request = urllib.request.Request(
    "https://gouvra.example.com/api/v1/hooks/<token>",
    data=body,
    headers={
        "Content-Type": "application/json",
        "Gouvra-Signature": f"t={timestamp},v1={digest}",
        "Idempotency-Key": "ticket-42-created",  # optional, see below
    },
)
print(urllib.request.urlopen(request).read().decode())
```

**Node.js**

```js
import { createHmac } from "node:crypto";

const secret = "gvwhsec_...";
const body = JSON.stringify({ ticket: { id: 42, title: "Refund" } });
const timestamp = Math.floor(Date.now() / 1000);
const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
const response = await fetch("https://gouvra.example.com/api/v1/hooks/<token>", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Gouvra-Signature": `t=${timestamp},v1=${digest}` },
  body,
});
console.log(response.status, await response.json());
```

**curl** (with `openssl`)

```bash
SECRET='gvwhsec_...'
BODY='{"ticket":{"id":42,"title":"Refund"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -sS https://gouvra.example.com/api/v1/hooks/<token> \
  -H 'Content-Type: application/json' -H "Gouvra-Signature: t=$TS,v1=$SIG" -d "$BODY"
```

Sign the **exact bytes** you send: re-serialising the JSON after signing (different spacing or key
order) breaks the signature.

### Idempotency and retries

Senders retry on timeouts; Gouvra makes sure one event starts one run:

- With an `Idempotency-Key` (or `Gouvra-Delivery`, or GitHub's `X-GitHub-Delivery`) header, every
  delivery with the same key gets the outcome of the first one (`200`, `"duplicate": true`).
- Without one, the same signed request (same timestamp and body) is recognised as the same
  delivery. A genuinely new event has a new timestamp, hence a new signature.

### GitHub webhooks

Create the webhook with the **GitHub** signature format, then in your repository's settings add a
webhook with the address, content type `application/json` and the secret. GitHub signs with
`X-Hub-Signature-256` (no timestamp); replays are caught by the `X-GitHub-Delivery` id, which is
required.

### From payload to input

- A JSON object becomes the run's JSON input as is; a JSON array becomes `{"items": [...]}`; any
  other body is passed as text.
- An **input template** shapes the input instead, with the same placeholders as workflows:
  `New ticket {{input.ticket.id}}: {{input.ticket.title}}` (text), or
  `{"id": {{input.ticket.id}}}` (JSON).

## Connectors

A connector packages an integration; adding a **connection** stores its credentials encrypted (they
are never shown again) and turns its operations into tools you can allow for any agent.

| Connector | Credentials | Operations |
|---|---|---|
| Slack | Incoming webhook URL | Post a message |
| Discord | Channel webhook URL | Post a message (mentions disabled) |
| GitHub | Fine-grained personal access token | Create an issue, comment on an issue, read an issue |
| Outgoing webhook | HTTPS endpoint, optional signing secret | Send an event |

Requests are built on the server from the tool's arguments (checked against the operation's
schema) and the decrypted credentials, and sent only to the connector's own hosts, on public
addresses. The model never sees a credential. **Check** runs a harmless call (GitHub: who am I;
Discord: the webhook's channel); Slack and outgoing webhooks are verified the first time they run.

### Verifying Gouvra's outgoing events

With a signing secret, outgoing webhook events carry the same `Gouvra-Signature` header as above.
Verify it on your side before trusting the event:

```python
import hashlib, hmac, time

def verify(secret: str, header: str, body: bytes, tolerance: int = 300) -> bool:
    parts = dict(item.split("=", 1) for item in header.split(","))
    timestamp = int(parts["t"])
    if abs(time.time() - timestamp) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])
```

## Limits and failure handling

- Every start goes through the same checks as a manual launch: workspace concurrency, execution
  rate limits and plan quotas.
- A start that fails (the agent was archived, a quota is reached…) is recorded with its reason.
  After **5 failures in a row**, the automation pauses itself and says why; resume it once fixed.
- Deliveries and scheduled runs are listed on each automation with their outcome and a link to the
  run they started. Deleting an automation keeps those runs in the history.
