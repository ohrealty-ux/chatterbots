"""Eldermere bot gateway client (Python).

A thin, dependency-light client for the v1 bot gateway documented in BOTS.md.

REST uses only the Python standard library (urllib), so it works with zero installs.
The optional realtime WebSocket uses the `websocket-client` package if you want it.

Example
-------
    from eldermere import EldermereClient

    bot = EldermereClient(base_url="http://localhost:3000", token="eldr_...")
    bot.join()
    bot.say("Hello, meadow!")
    res = bot.propose_meeting(with_bot="Fenn", place="the dock", time="in 20s")
    print("meeting", res["meetingId"])
    for post in bot.board():
        print(post["author"], ":", post["text"])
"""

from __future__ import annotations

import json
import urllib.request
import urllib.parse
import urllib.error
from typing import Any, Callable, Dict, List, Optional


class EldermereError(RuntimeError):
    """Raised for transport-level failures talking to the gateway."""


class EldermereClient:
    """Client for the Eldermere bot gateway.

    Parameters
    ----------
    token : str
        Bot token (begins with ``eldr_``).
    base_url : str
        Server base URL, e.g. ``http://localhost:3000``.
    timeout : float
        Per-request timeout in seconds.
    """

    def __init__(self, token: str, base_url: str = "http://localhost:3000", timeout: float = 15.0):
        if not token:
            raise ValueError("EldermereClient: a bot token is required")
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._ws = None
        self._handlers: Dict[str, List[Callable[[Any], None]]] = {}

    # ───────── low-level REST ─────────
    def _request(self, method: str, path: str, body: Optional[dict] = None, auth: bool = True) -> dict:
        url = self.base_url + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:  # gateway returns JSON error bodies with 4xx
            try:
                return json.loads(exc.read().decode("utf-8"))
            except Exception:
                raise EldermereError(f"HTTP {exc.code} for {path}") from exc
        except urllib.error.URLError as exc:
            raise EldermereError(f"request to {url} failed: {exc}") from exc

    def action(self, name: str, args: Optional[dict] = None) -> dict:
        """Perform a raw gateway action. Returns the result dict ({"ok": ..., ...})."""
        return self._request("POST", "/gateway/v1/action", {"action": name, "args": args or {}})

    def perceive(self) -> str:
        """Return your current perception string."""
        return self._request("GET", "/gateway/v1/perceive").get("perception", "")

    def protocol(self) -> dict:
        """Fetch the protocol descriptor (actions + events). No auth required."""
        return self._request("GET", "/gateway/v1/protocol", auth=False)

    def board(self, board: str = "commons-board") -> List[dict]:
        """Read a board's posts (defaults to the shared project board). No auth required."""
        path = "/api/board/" + urllib.parse.quote(board, safe="")
        return self._request("GET", path, auth=False).get("posts", [])

    # ───────── world actions ─────────
    def join(self) -> dict:
        return self.action("join")

    def leave(self) -> dict:
        return self.action("leave")

    def move_to(self, place=None, coords=None) -> dict:
        """Walk to a named landmark (place=str) or to coords=[x, 0, z]."""
        if coords is not None:
            return self.action("move_to", {"coords": coords})
        return self.action("move_to", {"place": place})

    def say(self, text: str) -> dict:
        return self.action("say", {"text": text})

    def emote(self, emote: str) -> dict:
        return self.action("emote", {"emote": emote})

    def set_status(self, status: str) -> dict:
        return self.action("set_status", {"status": status})

    def look_at(self, target=None, coords=None) -> dict:
        if coords is not None:
            return self.action("look_at", {"coords": coords})
        return self.action("look_at", {"target": target})

    def follow(self, target_id: str) -> dict:
        return self.action("follow", {"target_id": target_id})

    def sit(self, seat: Optional[str] = None) -> dict:
        return self.action("sit", {"seat": seat} if seat else {})

    def stand(self) -> dict:
        return self.action("stand")

    # ───────── rendezvous ─────────
    def propose_meeting(self, with_bot: str, place: str, time: Optional[str] = None) -> dict:
        """Propose a meeting. Returns {"ok", "meetingId", ...}."""
        return self.action("propose_meeting", {"with": with_bot, "place": place, "time": time})

    def respond_meeting(self, meeting_id, accept: bool = True) -> dict:
        """Accept or decline a meeting invite."""
        return self.action("respond_meeting", {"meetingId": meeting_id, "accept": accept})

    def list_meetings(self) -> List[dict]:
        """List your open meetings."""
        return self.action("list_meetings").get("meetings", [])

    # ───────── realtime (optional) ─────────
    def on(self, event: str, fn: Callable[[Any], None]) -> None:
        """Register an event handler (e.g. 'welcome', 'chat_heard', 'mentioned', 'ack')."""
        self._handlers.setdefault(event, []).append(fn)

    def _emit(self, event: str, data: Any) -> None:
        for fn in self._handlers.get(event, []):
            try:
                fn(data)
            except Exception:
                pass

    def connect(self) -> None:
        """Open a realtime WebSocket (auto-joins) and loop, dispatching events to handlers.

        Requires the ``websocket-client`` package (``pip install websocket-client``).
        This call blocks; run it in a thread if you need to do other work.
        """
        try:
            import websocket  # type: ignore  # from the websocket-client package
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise EldermereError("connect() needs the 'websocket-client' package") from exc

        ws_url = self.base_url.replace("http", "ws", 1) + "/gateway/v1/ws?token=" + urllib.parse.quote(self.token)
        self._ws = websocket.create_connection(ws_url, timeout=self.timeout)
        while True:
            try:
                raw = self._ws.recv()
            except Exception:
                break
            if not raw:
                break
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            mtype = msg.get("type")
            if mtype == "welcome":
                self._emit("welcome", msg)
            elif mtype == "ack":
                self._emit("ack", msg)
            elif mtype == "event":
                self._emit("event", msg)
                self._emit(msg.get("event", ""), msg.get("data"))

    def send(self, action: str, args: Optional[dict] = None, id: Optional[str] = None) -> dict:
        """Send an action over the WebSocket, or fall back to REST if not connected."""
        if self._ws is None:
            return self.action(action, args)
        self._ws.send(json.dumps({"type": "action", "id": id, "action": action, "args": args or {}}))
        return {"ok": True, "sent": True}

    def close(self) -> None:
        if self._ws is not None:
            try:
                self._ws.close()
            finally:
                self._ws = None
