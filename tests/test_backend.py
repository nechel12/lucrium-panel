"""Тесты локального backend панели: настройки, WSS-клиент, API."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from lucrium_protocol import (
    PingParams,
    PingResult,
    Request,
    ServerEvent,
    StateSnapshot,
    StatusCounts,
    WorkerStatus,
    build_event,
    build_response,
    parse_envelope,
)
from websockets.asyncio.server import serve

from lucrium_panel.api import create_app
from lucrium_panel.settings import PanelSettings
from lucrium_panel.worker_client import ConnectionStatus, WorkerClient


def _snapshot() -> StateSnapshot:
    now = datetime.now(UTC)
    return StateSnapshot(
        revision=3,
        generated_at=now,
        status=WorkerStatus(
            version="0.1.0",
            protocol="1",
            started_at=now,
            uptime_seconds=10,
            python="3.12.0",
            os="linux",
            sessions=StatusCounts(total=0, running=0, error=0),
            plugins=StatusCounts(total=0, running=0, error=0),
        ),
    )


def test_settings_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "panel.json"
    settings = PanelSettings().with_connection(worker_url="1.2.3.4:8443", token="t" * 64)
    settings.save(path)
    loaded = PanelSettings.load(path)
    assert loaded.worker_url == "1.2.3.4:8443"
    assert loaded.normalized_url() == "wss://1.2.3.4:8443"
    assert loaded.configured
    masked = loaded.masked()
    assert "token" not in masked
    assert masked["token_hint"].endswith("tttt")


def test_settings_missing_file(tmp_path: Path) -> None:
    loaded = PanelSettings.load(tmp_path / "missing.json")
    assert not loaded.configured


async def test_worker_client_connects_and_requests(tmp_path: Path) -> None:
    async def handler(websocket: Any) -> None:
        await websocket.send(build_event(ServerEvent.STATE, _snapshot()).model_dump_json())
        async for raw in websocket:
            envelope = parse_envelope(raw)
            if isinstance(envelope, Request):
                pong = PingResult(nonce="pong", server_time=datetime.now(UTC), revision=3)
                await websocket.send(build_response(envelope, pong).model_dump_json())

    server = await serve(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    client = WorkerClient(settings_path=tmp_path / "panel.json")
    try:
        await client.reconfigure(worker_url=f"ws://127.0.0.1:{port}", token="t" * 64)
        await client.start()
        await _wait_until(lambda: client.connected, timeout=10)
        await _wait_until(lambda: client.info()["state"] is not None, timeout=10)

        info = client.info()
        assert info["status"] == ConnectionStatus.CONNECTED.value
        assert info["revision"] == 3

        result = await client.request("ping", PingParams(nonce="x").model_dump(mode="json", exclude={"method"}))
        assert result["nonce"] == "pong"
    finally:
        await client.stop()
        server.close()
        await server.wait_closed()


async def test_worker_client_not_configured(tmp_path: Path) -> None:
    client = WorkerClient(settings_path=tmp_path / "panel.json")
    await client.start()
    try:
        await asyncio.sleep(0.05)
        assert client.info()["status"] == ConnectionStatus.DISCONNECTED.value
        with pytest.raises(Exception, match="нет соединения"):
            await client.request("ping", {})
    finally:
        await client.stop()


class FakeWorker:
    """Дух WorkerClient для API-тестов: записывает вызовы."""

    def __init__(self) -> None:
        self.settings = PanelSettings().with_connection(worker_url="wss://worker:8443", token="t" * 64)
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.reconfigured: list[tuple[str, str, bool]] = []
        self.cleared = False

    def info(self) -> dict[str, Any]:
        return {"status": "connected", "detail": "ok", "url": self.settings.normalized_url(), "state": None}

    async def request(self, method: str, params: dict[str, Any] | None = None, **_: Any) -> dict[str, Any]:
        self.calls.append((method, dict(params or {})))
        if method == "rotate_token":
            return {"token": "new-token" * 8, "rotated_at": datetime.now(UTC).isoformat()}
        return {"ok": True, "method": method}

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        return asyncio.Queue()

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        return None

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def reconfigure(self, *, worker_url: str, token: str, verify_tls: bool = False) -> None:
        self.reconfigured.append((worker_url, token, verify_tls))
        self.settings = self.settings.with_connection(worker_url=worker_url, token=token, verify_tls=verify_tls)

    async def clear(self) -> None:
        self.cleared = True


@pytest.fixture
async def api() -> Any:
    worker = FakeWorker()
    app = create_app(client=worker)  # type: ignore[arg-type]
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, worker


async def test_api_state_and_command(api: Any) -> None:
    client, worker = api
    response = await client.get("/api/state")
    assert response.status_code == 200
    assert response.json()["status"] == "connected"

    response = await client.post("/api/command", json={"method": "ping", "params": {"nonce": "x"}})
    assert response.status_code == 200
    assert worker.calls[-1] == ("ping", {"nonce": "x"})


async def test_api_add_account_sends_plaintext_credentials(api: Any) -> None:
    client, worker = api
    body = {
        "platform": "funpay",
        "label": "Основной",
        "credentials": {"platform": "funpay", "golden_key": "gk-live"},
    }
    response = await client.post("/api/accounts", json=body)
    assert response.status_code == 200
    method, params = worker.calls[-1]
    assert method == "add_account"
    assert params["account"]["credentials"]["golden_key"] == "gk-live"


async def test_api_export_does_not_mask_passphrase(api: Any) -> None:
    client, worker = api
    response = await client.post("/api/export", json={"passphrase": "super-secret-pass"})
    assert response.status_code == 200
    method, params = worker.calls[-1]
    assert method == "export_state"
    assert params["passphrase"] == "super-secret-pass"


async def test_api_settings_and_rotate(api: Any) -> None:
    client, worker = api
    response = await client.put("/api/settings", json={"worker_url": "10.0.0.1:8443", "token": "n" * 64})
    assert response.status_code == 200
    assert worker.reconfigured[-1][0] == "10.0.0.1:8443"

    response = await client.post("/api/token/rotate")
    assert response.status_code == 200
    assert response.json()["token"]
    # панель сохранила новый токен и переподключилась
    assert worker.reconfigured[-1][1] == response.json()["token"]


async def test_api_worker_error_maps_to_http(api: Any) -> None:
    from lucrium_panel.worker_client import WorkerError

    client, worker = api

    async def failing(method: str, params: dict[str, Any] | None = None, **_: Any) -> dict[str, Any]:
        raise WorkerError("unavailable", "нет связи")

    worker.request = failing  # type: ignore[method-assign]
    response = await client.post("/api/command", json={"method": "ping"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "unavailable"


async def _wait_until(predicate: Any, *, timeout: float) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition was not met in time")
        await asyncio.sleep(0.02)
