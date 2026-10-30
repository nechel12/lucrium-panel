"""WSS-клиент панели к воркеру: реконнект, корреляция, кэш состояния.

Панель подключается к воркеру (dial-in), а не наоборот (спека §5). Локальный
FastAPI-бэкенд держит одно соединение и раздаёт его фронтенду через свой WS.
"""

from __future__ import annotations

import asyncio
import contextlib
import ssl
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from lucrium_protocol import (
    Event,
    ProtocolError,
    Response,
    ServerEvent,
    build_request,
    parse_envelope,
)
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .settings import PanelSettings

MAX_MESSAGE_BYTES = 64 * 1024 * 1024
REQUEST_TIMEOUT = 30.0
BACKOFF_START = 1.0
BACKOFF_MAX = 30.0


class ConnectionStatus(StrEnum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


class WorkerError(Exception):
    """Воркер вернул ошибку или соединение недоступно."""

    def __init__(self, code: str, message: str, data: dict[str, Any] | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.data = data


@dataclass(slots=True)
class _Connection:
    status: ConnectionStatus = ConnectionStatus.DISCONNECTED
    detail: str = "не настроено"


@dataclass(slots=True)
class WorkerClient:
    settings_path: Path | None = None
    _settings: PanelSettings = field(init=False)
    _connection: _Connection = field(default_factory=_Connection)
    _snapshot: dict[str, Any] | None = None
    _worker_status: dict[str, Any] | None = None
    _pending: dict[str, asyncio.Future[Response]] = field(default_factory=dict)
    _subscribers: set[asyncio.Queue[dict[str, Any]]] = field(default_factory=set)
    _supervisor: asyncio.Task[None] | None = None
    _ws: Any = None
    _wake: asyncio.Event = field(default_factory=asyncio.Event)
    _stopped: bool = False

    def __post_init__(self) -> None:
        self._settings = PanelSettings.load(self.settings_path)

    # --- состояние ------------------------------------------------------------

    @property
    def settings(self) -> PanelSettings:
        return self._settings

    @property
    def connected(self) -> bool:
        return self._connection.status is ConnectionStatus.CONNECTED

    def info(self) -> dict[str, Any]:
        return {
            "status": self._connection.status.value,
            "detail": self._connection.detail,
            "url": self._settings.normalized_url(),
            "revision": None if self._snapshot is None else self._snapshot.get("revision"),
            "worker": self._worker_status,
            "state": self._snapshot,
        }

    # --- жизненный цикл -------------------------------------------------------

    async def start(self) -> None:
        if self._supervisor is None:
            self._stopped = False
            self._supervisor = asyncio.create_task(self._supervise(), name="panel-worker-connection")

    async def stop(self) -> None:
        self._stopped = True
        self._wake.set()
        if self._supervisor is not None:
            self._supervisor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._supervisor
            self._supervisor = None
        await self._close_ws()
        self._fail_pending("панель остановлена")

    async def reconfigure(self, *, worker_url: str, token: str, verify_tls: bool = False) -> None:
        self._settings = self._settings.with_connection(worker_url=worker_url, token=token, verify_tls=verify_tls)
        self._settings.save(self.settings_path)
        self._snapshot = None
        self._worker_status = None
        await self._close_ws()
        self._wake.set()

    async def clear(self) -> None:
        """Забыть адрес и токен (переход на экран первоначальной настройки)."""
        self._settings = PanelSettings()
        self._settings.save(self.settings_path)
        self._snapshot = None
        self._worker_status = None
        await self._close_ws()
        self._wake.set()

    # --- подписка на события --------------------------------------------------

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def _broadcast(self, message: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(message)

    # --- запросы --------------------------------------------------------------

    async def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = REQUEST_TIMEOUT,
    ) -> dict[str, Any]:
        ws = self._ws
        if ws is None or not self.connected:
            raise WorkerError("unavailable", "нет соединения с воркером")
        try:
            request = build_request(method, params or {})
        except ProtocolError as exc:
            raise WorkerError(exc.code.value, exc.message, exc.data) from exc

        future: asyncio.Future[Response] = asyncio.get_running_loop().create_future()
        self._pending[request.id] = future
        try:
            await ws.send(request.model_dump_json())
            response = await asyncio.wait_for(future, timeout)
        except TimeoutError as exc:
            self._pending.pop(request.id, None)
            raise WorkerError("timeout", f"воркер не ответил на {method!r} за {timeout:.0f} с") from exc
        except Exception as exc:
            self._pending.pop(request.id, None)
            if isinstance(exc, WorkerError):
                raise
            raise WorkerError("unavailable", f"ошибка отправки: {exc}") from exc
        if response.payload.error is not None:
            error = response.payload.error
            raise WorkerError(error.code.value, error.message, error.data)
        return dict(response.payload.result or {})

    # --- соединение -----------------------------------------------------------

    async def _supervise(self) -> None:
        backoff = BACKOFF_START
        while not self._stopped:
            if not self._settings.configured:
                self._set_connection(ConnectionStatus.DISCONNECTED, "воркер не настроен")
                await self._wait_wake()
                continue
            self._set_connection(ConnectionStatus.CONNECTING, self._settings.normalized_url())
            try:
                await self._run_connection()
                backoff = BACKOFF_START
            except InvalidStatus as exc:
                code = exc.response.status_code
                self._set_connection(ConnectionStatus.ERROR, f"HTTP {code}: проверьте pairing-токен")
            except asyncio.CancelledError:
                raise
            except (OSError, TimeoutError, ConnectionClosed) as exc:
                self._set_connection(ConnectionStatus.ERROR, f"нет связи: {exc}")
            except Exception as exc:
                self._set_connection(ConnectionStatus.ERROR, f"{type(exc).__name__}: {exc}")
            finally:
                self._ws = None
                self._fail_pending("соединение с воркером потеряно")
            if self._stopped:
                break
            if self._wake.is_set():
                self._wake.clear()
                backoff = BACKOFF_START
                continue
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX)

    async def _run_connection(self) -> None:
        url = self._settings.normalized_url()
        ssl_context = _ssl_context(self._settings) if url.startswith("wss://") else None
        async with connect(
            url,
            ssl=ssl_context,
            additional_headers={"Authorization": f"Bearer {self._settings.token}"},
            open_timeout=10,
            ping_interval=20,
            ping_timeout=20,
            max_size=MAX_MESSAGE_BYTES,
        ) as websocket:
            self._ws = websocket
            self._set_connection(ConnectionStatus.CONNECTED, "подключено")
            async for raw in websocket:
                self._handle(raw)
                if self._wake.is_set():
                    break

    async def _wait_wake(self) -> None:
        await self._wake.wait()
        self._wake.clear()

    async def _close_ws(self) -> None:
        ws = self._ws
        self._ws = None
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

    def _fail_pending(self, message: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(WorkerError("unavailable", message))
        self._pending.clear()

    def _set_connection(self, status: ConnectionStatus, detail: str) -> None:
        self._connection.status = status
        self._connection.detail = detail
        self._broadcast({"kind": "connection", "status": status.value, "detail": detail})

    # --- входящие -------------------------------------------------------------

    def _handle(self, raw: str | bytes) -> None:
        try:
            envelope = parse_envelope(raw)
        except ProtocolError:
            return
        if isinstance(envelope, Response):
            future = self._pending.pop(envelope.id, None)
            if future is not None and not future.done():
                future.set_result(envelope)
            return
        if isinstance(envelope, Event):
            self._handle_event(envelope)

    def _handle_event(self, event: Event) -> None:
        name = str(event.payload.event)
        data = event.payload.data
        payload = data.model_dump(mode="json")
        if name == ServerEvent.STATE:
            self._snapshot = payload
        elif name == ServerEvent.STATUS:
            self._worker_status = payload
        self._broadcast({"kind": "event", "event": name, "data": payload})


def _ssl_context(settings: PanelSettings) -> ssl.SSLContext:
    context = ssl.create_default_context()
    if not settings.verify_tls:
        # самоподписанный сертификат из install.sh: пользователь подключается к своему VPS
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


async def events_stream(client: WorkerClient) -> AsyncIterator[dict[str, Any]]:
    """Бесконечный поток сообщений для локального WS фронтенда."""
    queue = client.subscribe()
    try:
        yield {"kind": "snapshot", "data": client.info()}
        while True:
            yield await queue.get()
    finally:
        client.unsubscribe(queue)


__all__ = [
    "BACKOFF_MAX",
    "BACKOFF_START",
    "ConnectionStatus",
    "WorkerClient",
    "WorkerError",
    "events_stream",
]
