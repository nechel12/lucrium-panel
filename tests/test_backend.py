"""Тесты локального backend панели: настройки, WSS-клиент, API."""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import ssl
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
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


def test_tls_fingerprint_normalization() -> None:
    from lucrium_panel.worker_client import _normalize_fingerprint

    digest = "ab" * 32
    assert _normalize_fingerprint(digest.upper()) == digest
    assert _normalize_fingerprint(f"SHA256:{digest.upper()}") == digest
    assert _normalize_fingerprint(":".join(digest[index : index + 2] for index in range(0, 64, 2))) == digest


def test_settings_malformed_json_types_are_ignored(tmp_path: Path) -> None:
    path = tmp_path / "panel.json"
    for payload in ("[]", "null", "42", '"value"'):
        path.write_text(payload, encoding="utf-8")
        assert PanelSettings.load(path) == PanelSettings()


def test_settings_string_boolean_is_parsed_strictly(tmp_path: Path) -> None:
    path = tmp_path / "panel.json"
    path.write_text(
        json.dumps({"worker_url": "host:8443", "token": "t" * 64, "verify_tls": "false"}),
        encoding="utf-8",
    )
    assert PanelSettings.load(path).verify_tls is False


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


def _self_signed_cert(tmp_path: Path) -> tuple[Path, Path, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(days=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path = tmp_path / "cert.pem"
    key_path = tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    return cert_path, key_path, hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()


async def test_fingerprint_is_verified_before_authorization_is_sent(tmp_path: Path) -> None:
    cert_path, key_path, fingerprint = _self_signed_cert(tmp_path)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    seen: dict[str, str | None] = {}

    async def handler(websocket: Any) -> None:
        seen["authorization"] = websocket.request.headers.get("Authorization")

    server = await serve(handler, "127.0.0.1", 0, ssl=context)
    port = server.sockets[0].getsockname()[1]
    client = WorkerClient(settings_path=tmp_path / "panel.json")
    try:
        await client.reconfigure(
            worker_url=f"wss://127.0.0.1:{port}",
            token="super-secret-pairing-token",
            verify_tls=True,
            tls_fingerprint="00" * 32,
        )
        await client.start()
        await _wait_until(lambda: client.info()["status"] == ConnectionStatus.ERROR.value, timeout=10)
        assert seen.get("authorization") is None
    finally:
        await client.stop()

    client = WorkerClient(settings_path=tmp_path / "panel.json")
    try:
        await client.reconfigure(
            worker_url=f"wss://127.0.0.1:{port}",
            token="super-secret-pairing-token",
            verify_tls=True,
            tls_fingerprint=fingerprint,
        )
        await client.start()
        await _wait_until(lambda: seen.get("authorization") is not None, timeout=10)
        assert seen["authorization"] == "Bearer super-secret-pairing-token"
    finally:
        await client.stop()
        server.close()
        await server.wait_closed()


class FakeWorker:
    """Дух WorkerClient для API-тестов: записывает вызовы."""

    def __init__(self) -> None:
        self.settings = PanelSettings().with_connection(worker_url="wss://worker:8443", token="t" * 64)
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.reconfigured: list[tuple[str, str, bool, str]] = []
        self.adopted: list[str] = []
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

    async def reconfigure(
        self,
        *,
        worker_url: str,
        token: str,
        verify_tls: bool = True,
        tls_fingerprint: str = "",
    ) -> None:
        self.reconfigured.append((worker_url, token, verify_tls, tls_fingerprint))
        self.settings = self.settings.with_connection(
            worker_url=worker_url,
            token=token,
            verify_tls=verify_tls,
            tls_fingerprint=tls_fingerprint,
        )

    async def clear(self) -> None:
        self.cleared = True

    async def adopt_token(self, token: str) -> None:
        self.adopted.append(token)
        self.settings = self.settings.with_connection(
            worker_url=self.settings.worker_url,
            token=token,
            verify_tls=self.settings.verify_tls,
            tls_fingerprint=self.settings.tls_fingerprint,
        )


@pytest.fixture
async def api() -> Any:
    worker = FakeWorker()
    app = create_app(client=worker)  # type: ignore[arg-type]
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as client:
        session = await client.get("/api/session")
        assert session.status_code == 200
        client.headers["X-Lucrium-CSRF"] = session.json()["token"]
        yield client, worker


async def test_api_state_and_command(api: Any) -> None:
    client, worker = api
    response = await client.get("/api/state")
    assert response.status_code == 200
    assert response.json()["status"] == "connected"

    response = await client.post("/api/command", json={"method": "ping", "params": {"nonce": "x"}})
    assert response.status_code == 200
    assert worker.calls[-1] == ("ping", {"nonce": "x"})


async def test_api_requires_launch_access_token() -> None:
    worker = FakeWorker()
    app = create_app(client=worker, access_token="launch-secret")  # type: ignore[arg-type]
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as client:
        assert (await client.get("/api/state")).status_code == 401
        session = await client.get("/api/session", headers={"X-Lucrium-Access": "launch-secret"})
        assert session.status_code == 200
        client.headers["X-Lucrium-Access"] = "launch-secret"
        client.headers["X-Lucrium-CSRF"] = session.json()["token"]
        assert (await client.get("/api/state")).status_code == 200

        # health остаётся доступен для smoke-проверки exe
        assert (await client.get("/api/health")).status_code == 200


async def test_api_requires_csrf_header(api: Any) -> None:
    client, _ = api
    token = client.headers.pop("X-Lucrium-CSRF")
    try:
        response = await client.post("/api/token/rotate")
        assert response.status_code == 403
    finally:
        client.headers["X-Lucrium-CSRF"] = token


async def test_api_rejects_cross_origin(api: Any) -> None:
    client, _ = api
    response = await client.post("/api/token/rotate", headers={"Origin": "https://evil.example"})
    assert response.status_code == 403


async def test_api_command_rejects_dangerous_method(api: Any) -> None:
    client, _ = api
    response = await client.post("/api/command", json={"method": "get_state"})
    assert response.status_code == 403


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


async def test_api_call_client(api: Any) -> None:
    client, worker = api
    response = await client.post(
        "/api/accounts/acc-1/call",
        json={"client_method": "items.list_self", "params": {"limit": 10}},
    )
    assert response.status_code == 200
    method, params = worker.calls[-1]
    assert method == "call_client"
    assert params == {"session_id": "acc-1", "client_method": "items.list_self", "params": {"limit": 10}}


async def test_api_event_history(api: Any) -> None:
    client, worker = api
    response = await client.get("/api/events/history?session_id=acc-1&limit=5")
    assert response.status_code == 200
    method, params = worker.calls[-1]
    assert method == "get_events"
    assert params["session_id"] == "acc-1"
    assert params["limit"] == 5


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


async def test_api_rotate_returns_token_when_settings_save_fails(api: Any) -> None:
    client, worker = api

    async def failing_reconfigure(**_: Any) -> None:
        raise OSError("read-only settings")

    worker.reconfigure = failing_reconfigure  # type: ignore[method-assign]
    response = await client.post("/api/token/rotate")
    assert response.status_code == 200
    body = response.json()
    assert body["token"]
    assert body["persisted"] is False
    assert "warning" in body
    assert "read-only" not in body["warning"]
    assert "OSError" not in body["warning"]
    assert worker.adopted[-1] == body["token"]


async def test_worker_client_reconfigure_keeps_settings_when_save_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = WorkerClient(settings_path=tmp_path / "panel.json")
    await client.reconfigure(
        worker_url="wss://old:8443",
        token="o" * 64,
        verify_tls=True,
        tls_fingerprint="",
    )

    def fail_save(self: PanelSettings, path: Path | None = None) -> Path:
        raise OSError("read-only settings")

    monkeypatch.setattr(PanelSettings, "save", fail_save)
    with pytest.raises(OSError):
        await client.reconfigure(
            worker_url="wss://new:8443",
            token="n" * 64,
            verify_tls=True,
            tls_fingerprint="",
        )
    assert client.settings.token == "o" * 64
    assert client.settings.worker_url == "wss://old:8443"


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
