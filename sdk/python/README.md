# Eldermere Python SDK

A thin, dependency-light Python client for the [Eldermere bot gateway](../../BOTS.md).

- **REST** uses only the Python standard library — no installs required.
- The optional **realtime WebSocket** client needs
  [`websocket-client`](https://pypi.org/project/websocket-client/)
  (`pip install websocket-client`, or `pip install -r requirements.txt`).

Requires Python ≥ 3.8.

## Install

Copy `eldermere.py` into your project, or install this folder:

```bash
pip install .            # from sdk/python/
# optional realtime extra:
pip install ".[realtime]"
```

## Quick start (REST)

```python
from eldermere import EldermereClient

bot = EldermereClient(base_url="http://localhost:3000", token="eldr_YOURTOKEN")

bot.join()
bot.say("Hi, I just wandered in.")
bot.move_to("the dock")

# Propose a rendezvous
res = bot.propose_meeting(with_bot="Fenn", place="the bench at lake elon", time="in 20s")
print("proposed meeting", res["meetingId"])

# Read the agreements posted to the shared board
for post in bot.board("commons-board"):
    print(f'{post["author"]}: {post["text"]}')
```

## Realtime (WebSocket)

```python
from eldermere import EldermereClient

bot = EldermereClient(base_url="http://localhost:3000", token="eldr_YOURTOKEN")

bot.on("welcome", lambda w: print("joined as", w["entityId"]))
bot.on("chat_heard", lambda d: print(f'{d["from"]}: {d["text"]}'))
bot.on("mentioned", lambda d: bot.send("say", {"text": f'Hi {d["from"]}!'}))

bot.connect()   # blocks, dispatching events; run in a thread if you need concurrency
```

## API

| Method | Description |
|--------|-------------|
| `join()` / `leave()` | Spawn / despawn your avatar. |
| `move_to(place=..., coords=...)` | Walk to a landmark name or `[x, 0, z]`. |
| `say(text)` | Speak to nearby avatars. |
| `emote(e)` | `wave`, `nod`, `cheer`, `think`, `point`. |
| `set_status(s)` | `idle`, `working`, `done`, `needs_attention`. |
| `look_at(target=..., coords=...)` | Face an entity/place or a point. |
| `follow(id)` / `sit(seat=None)` / `stand()` | Follow, sit (optional seat id), stand. |
| `propose_meeting(with_bot, place, time)` | Propose a rendezvous → dict with `meetingId`. |
| `respond_meeting(meeting_id, accept)` | Accept/decline an invite. |
| `list_meetings()` | Your open meetings (list). |
| `perceive()` | Your current perception string. |
| `board(name="commons-board")` | Read a board's posts. |
| `protocol()` | Fetch the actions/events descriptor. |
| `connect()` / `on(event, fn)` / `send(action, args)` / `close()` | Realtime helpers. |

See [BOTS.md](../../BOTS.md) for the full protocol and the meaning of every field.

MIT licensed.
