# Digital Pickleball Queue — commented full-stack starter

This project includes an Express + MongoDB/Mongoose backend, Socket.IO synchronization, a mobile/kiosk check-in screen, a TV board, an admin dashboard, and isolated matchmaking tests. It is a single-facility reference implementation, not a hosted production deployment.

## Start locally

1. Install Node.js 22 or newer and use MongoDB Atlas or a local MongoDB **replica set**. Transactions do not work on standalone MongoDB.
2. Inside this directory, run `npm install`.
3. Copy `.env.example` to `.env`, set `MONGODB_URI`, and replace `ADMIN_TOKEN` with a long random secret.
4. Run `npm run seed`, then `npm start`.
5. Open `http://localhost:3000/` for check-in, `/tv.html` for TV, and `/admin.html` for staff. Enter the admin token on the staff page.
6. Generate your printed QR code using the deployed HTTPS check-in URL. The QR is just a link; phone camera access and a QR generator are not needed inside this app.
7. Run `npm test` to test the allocator. These tests need neither a MongoDB server nor installed runtime dependencies.

Deploy on a Node host supporting persistent WebSocket connections and HTTPS, with MongoDB Atlas. The Node process must stay running for the SMS worker. A static HTML host alone cannot run this backend. Run only the seed command against your intended database; increasing the count creates missing courts, decreasing it does not delete existing courts.

## Where to edit

| Change | Exact location |
|---|---|
| Initial number of courts | `.env`: `COURT_COUNT`; run `npm run seed` |
| Active court count | Admin page: set unused courts to Maintenance or Tournament |
| Minimum/maximum party size | `src/config.js`: `minGroup`, `maxGroup`; `public/checkin.js`: matching add-player limit and button check |
| Doubles capacity | `src/config.js`: `capacity=4`; the implementation assumes two teams of two, so changing capacity requires rewriting team/rotation validations |
| Match duration estimate | `defaultMinutes` in `src/config.js` for new courts; existing court `averageMinutes` via PATCH API |
| TV/mobile/admin colors | `public/styles.css`: `--bg`, `--panel`, `--text`, `--muted`, `--accent`, `--danger` |
| Beginner/Advanced skill filtering | `src/queue.js`: `eligible()` |
| SMS credentials | `.env`: three `TWILIO_*` variables; blank disables sending |
| Branding text | `public/tv.html`, `public/index.html`, `public/admin.html` |

`callGraceMinutes` is reserved for a future timeout policy; this starter uses staff-confirmed no-shows, not automatic expiry.

## Product rules and queue behavior

**Lifecycle:** check-in creates a profile and private bearer credential. Joining creates one immutable party of 1–4 unique players. A player cannot occupy two queue/match slots. Entries progress `waiting → called → playing → done`. A called match reserves its court immediately; staff starts it once players arrive. Finished players may join again using the same check-in credentials through the API; the kiosk UI starts a new check-in on refresh.

**Four-on/four-off:** after staff finishes a match, all four leave and their profiles become available. Players who wish to play again rejoin at the tail; there is no silent auto-requeue. Existing parties remain intact.

**Challenge and King of the Court:** both implement winner-stays (2-on/2-off) in this starter. Staff chooses the winning team. Winners keep their court and join two compatible waiting challengers. No score inference or automatic result detection occurs. `winnerTeam:null` resets all four off, including the King court. No streak cap is imposed; add a match win-streak field if your venue needs one.

**Parties stay in the same match.** Exact-fill dynamic programming selects whole groups. Examples: 3+1, 2+2, 2+1+1, 4, or four solos. A group of three alone cannot play. With two challenger spots, parties of three/four wait for a four-player reset or another compatible court. A group can share a match without always sharing a team. For a group of three/four, retaining only two winners would split that party across the next match: the API rejects it and staff must reset all-off. When a 2+2 team partition exists, parties also remain on the same team.

**Fairness:** choose the oldest eligible party that can belong to a full match, then the earliest compatible completion. An unfillable oldest party can be bypassed. This favors court utilization but does not guarantee a maximum wait; the venue should monitor bypassed large parties and use manual assignment or all-off resets. Admin priority overrides FIFO. Rating boundaries apply to every player; an unknown DUPR cannot satisfy a court with a DUPR boundary. Ratings are self-reported, not verified with a DUPR service.

**Deck:** groups are reserved once in the preview across courts sorted by court name. A busy normal court previews four replacements; a busy winner-stays court previews two challengers. This is provisional and can change with eligibility, results, or overrides. Once called, players appear in the called court rather than the waiting deck. Normal deck ETA estimates the remainder of one configured match duration, including called time as a coarse fallback. Challenge ETA is “Wait varies.” This version does not fabricate wait estimates for every waiting party; exact fills, groups and indefinite winner retention make a simple queue-position formula unreliable. A production extension should simulate multiple court availability timelines with the same allocator and show a range.

**No-shows:** staff bumps an entire party. If called, cancel the entire called match, restore other parties to their original positions, then dispatch replacements. Already-playing parties cannot be bumped. Pause the queue before doing several manual changes to prevent auto-dispatch consuming a selection; manually assign while globally paused, then resume when ready. A global pause blocks automatic dispatch, but staff manual assignment remains available. Manual assignment requires an active/unpaused empty court, four unique players and compatible whole entries. Overrides do not split groups or bypass eligibility.

## System and event architecture

The server owns state. Clients submit commands through REST; sockets carry server notifications only. Mobile, kiosk and TV receive the same public projection. Private phone numbers, consent and tokens never enter that projection.

1. Check-in validates profile fields and returns a private credential.
2. Queue submission verifies every party member's credential.
3. The server starts a MongoDB transaction, writes the facility lock revision, loads current queues/courts, selects whole parties, and updates users, entries, matches, courts and SMS outbox together.
4. MongoDB commits, then the server broadcasts a full state snapshot. **Never emit or send SMS inside a transaction callback:** it can be retried on a write conflict.
5. Clients compare `revision` and ignore older snapshots. Equal revisions are allowed to refresh ETA. Reconnection requests a full snapshot rather than assuming event replay.
6. A ten-second reconciliation broadcast recovers a crash between commit and socket emission. Server-local announcements may duplicate after restart; UI state comes from snapshots, not counting event deliveries.
7. The worker atomically claims an SMS job and submits it to Twilio only for consenting players whose match is still called.

MongoDB's lock document serializes ALL queue mutations across Node processes, avoiding two courts consuming the same player. Snapshots use a read-only transaction to keep revision and records consistent. This reference implementation has one facility and broadcasts through one Socket.IO process. If horizontally scaling, add a Socket.IO adapter or facility-room fan-out, facility-scoped locks and authorization; a database lock alone does not broadcast between socket servers.

Socket.IO defaults to at-most-once event delivery. Snapshot reconciliation, not a socket event alone, is what restores state after disconnects. See [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/). Mongoose transaction callbacks and retry behavior are described in [Mongoose transactions](https://mongoosejs.com/docs/transactions.html).

### SMS reliability

Outbox keys are unique per match/player and created within the assignment transaction. Statuses: `pending → sending → accepted`, or `failed`/`uncertain`. Twilio acceptance is not proof of handset delivery. See [Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource).

A process crash can leave `sending` jobs; provider timeouts become `uncertain`. Do not blindly retry them: inspect the provider outcome to avoid double texts. Automatic reconciliation/retries and signed delivery-status callbacks are production extensions. SMS is best-effort: cancellation can race a message already being sent. The live board remains authoritative. A future worker should use leased claims, provider reconciliation and cancellation checks. No SMS was sent during development.

## Database schemas

Actual Mongoose definitions and indexes are in `src/models.js`.

| Model | Main fields | Purpose |
|---|---|---|
| User | name, skill, dupr, phone, smsConsent, tokenHash, busy | Profile/private credential and duplicate participation guard |
| Court | name, type, status, paused, currentMatch, minDupr, maxDupr, averageMinutes | Eligibility and occupancy |
| QueueEntry | players[], types[], priority, status, match, timestamps | Indivisible party and ordering |
| Match | court, entries[], players[], teams[][], retainedPlayers[], status, calledAt, startedAt, endedAt | Reservation, team result and rotation history |
| State | facility ID, revision, paused | Global queue controls and transaction lock |
| Sms | unique key, match, user, body, status, providerSid, attemptedAt, error | Durable notification intent |

Courts have unique names. Queue entries index status/priority/createdAt; SMS keys are unique. `busy` is enforced by transactional service operations, not a multikey uniqueness trick. Do not write models directly from new routes without `mutate()`. For multi-venue support, add a facility ID to every model, compound indexes, facility membership and room-scoped snapshots.

## REST specification

Requests and responses use JSON. Admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`. Errors return `{ "error": "message" }`: 400 invalid input, 401 unauthorized, 404 missing resource, 409 stale/conflicting action, 500 internal failure. No phone data is available via a public read API.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/state` | Public snapshot: revision, serverTime, paused, courts, queue, deck |
| POST | `/api/users/check-in` | `{name,skill,dupr?,phone?,smsConsent?}` → `{userId,token}` |
| POST | `/api/queue` | `{members:[{userId,token}],types:["Beginner"]}` → `{entryId}` |
| PATCH | `/api/admin/settings` | `{paused:true}` |
| PATCH | `/api/admin/courts/:id` | Subset of `{name,type,status,paused,minDupr,maxDupr,averageMinutes}`; use null to clear DUPR limits |
| POST | `/api/admin/queue/reorder` | `{entryIds:[...]}`: complete current waiting list, each ID once |
| POST | `/api/admin/queue/:id/no-show` | `{}`: bump whole waiting/called party |
| POST | `/api/admin/matches/assign` | `{courtId,entryIds:[...]}` → `{matchId}` |
| POST | `/api/admin/matches/:id/start` | `{}`: called → playing |
| POST | `/api/admin/matches/:id/finish` | `{winnerTeam:null}` all-off, or 0/1 winner-stays |

Successful admin actions return `{ok:true}` except finish (courtId/matchId) and manual assignment (matchId). The admin page covers court types/status, pause, manual assignment, no-shows, reorder, starts and finishes. Rating ranges and average duration are API-editable; their form controls are an extension.

### Example party join

```js
// Each of these credentials came from POST /api/users/check-in.
const response = await fetch('/api/queue', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    members: [{ userId: firstId, token: firstToken }, { userId: secondId, token: secondToken }],
    types: ['Challenge', 'King of the Court']
  })
});
```

## Socket event specification

| Event | Direction | Payload and handling |
|---|---|---|
| `state:snapshot` | Server → connecting client | Complete public state; render immediately |
| `queue:updated` | Server → all clients | Complete public state after commits and every ten seconds; discard revisions lower than rendered revision |
| `match:called` | Server → all clients | `{revision,courtId,matchId,players:[names]}`; notification hint, followed by snapshot |
| `court:vacated` | Server → all clients | `{revision,courtId,matchId}` for the finished match; replacement may already occupy the court, so use snapshot |
| `connect` / `disconnect` | Socket.IO lifecycle | Fetch state on connect; show stale/offline warning on disconnect |

There is deliberately no client-emitted `court:vacated`: only authenticated staff may finish a match through REST. “Vacated” describes the previous match ending, not an assertion that the court remains empty. Match event hints can duplicate or coalesce; snapshots are the source of truth.

## TV layout blueprint

`public/tv.html` is the semantic HTML structure: main header, responsive court-card section, waiting parties and footer. `styles.css` uses Grid for cards and Flexbox for headers. Each card displays court name/type/status, currently playing or called names, and next challengers/replacements. Fluid text uses `clamp()`, with high contrast and large names. `board.js` uses DOM `textContent` for untrusted names and shows connection freshness. Use fullscreen and adjust browser zoom for viewing distance. It scrolls when many courts exceed the screen; paged/rotating displays are a useful extension for large venues.

## Verification and production boundary

The allocator tests cover 3+1, 2+2, incompatible groups, FIFO/priority, missing ratings, team preservation, and deck reservations. An exhaustive check covers all 4,096 six-party size sequences, comparing exact-fill existence against brute-force subsets. JavaScript syntax is also checked.

Database/HTTP/socket/Twilio integration requires a configured replica set and runtime packages; isolated allocator tests do not establish end-to-end deployment readiness. Before public launch, test concurrent joins/finishes against a real replica set, crash/reconnect behavior, SMS provider outcomes, staff no-show workflows, and TV legibility at your venue.

The starter uses a shared admin bearer token and self-reported check-ins. Add staff accounts and roles, profile update/reuse/rejoin UI, kiosk identity confirmation, command idempotency keys and audit history for a production venue. A lost HTTP response after a committed join can look like an error on retry; `busy` prevents double participation, but a future idempotency key should return the original response. Retain contacts only as needed and apply a venue retention policy. HTTPS and controlled staff-token distribution are required. No deployment or paid provider account is provisioned by this package.
