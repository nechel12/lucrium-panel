"""Локальный HTTP/WS API панели (FastAPI на 127.0.0.1).

Фронтенд не общается с воркером напрямую: только через этот backend, который
держит одно WSS-соединение и раздаёт события. Так pairing-токен не попадает
в браузер/webview.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import secrets
import time
import urllib.request
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import FastAPI, File, Form, HTTPException, Query, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from lucrium_protocol import (
    AccountCredentials,
    AccountInput,
    CallClientParams,
    Command,
    ExportStateParams,
    GetEventsParams,
    GetLogsParams,
    ImportMode,
    ImportStateParams,
    InstallPluginParams,
    LogLevel,
    LogScope,
    ProxyConfig,
    RemovePluginParams,
    RestartParams,
    RestartScope,
    SetPluginConfigParams,
    UpdateAccountParams,
    to_wire,
)
from pydantic import BaseModel, Field, SecretStr, ValidationError
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .worker_client import WorkerClient, WorkerError

MAX_UPLOAD_BYTES = 48 * 1024 * 1024
ACCOUNT_OPERATION_TIMEOUT = 60.0
PLUGIN_OPERATION_TIMEOUT = 180.0
STATE_TRANSFER_TIMEOUT = 300.0
CLIENT_CALL_TIMEOUT = 90.0
UPDATE_CHECK_URL = "https://api.github.com/repos/nechel12/lucrium-panel/releases/latest"
_update_cache: dict[str, Any] = {"at": 0.0, "payload": None}
logger = logging.getLogger("lucrium.panel")

LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
SESSION_COOKIE = "lucrium_session"
ACCESS_COOKIE = "lucrium_access"
ACCESS_HEADER = "x-lucrium-access"
CSRF_HEADER = "x-lucrium-csrf"
SAFE_COMMANDS = frozenset({Command.PING})
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class SettingsBody(BaseModel):
    worker_url: str = Field(default="", max_length=500)
    token: str = Field(default="", max_length=500)
    verify_tls: bool = True
    tls_fingerprint: str = Field(default="", max_length=200)


class CommandBody(BaseModel):
    method: str = Field(min_length=1, max_length=64)
    params: dict[str, Any] = Field(default_factory=dict)


class AccountPatch(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    credentials: dict[str, Any] | None = None
    proxy: dict[str, Any] | None = None
    clear_proxy: bool = False


class ConfigBody(BaseModel):
    config: dict[str, Any] = Field(default_factory=dict)


class CallBody(BaseModel):
    client_method: str = Field(min_length=1, max_length=200)
    params: dict[str, Any] = Field(default_factory=dict)


class ExportBody(BaseModel):
    passphrase: str = Field(min_length=8, max_length=1024)


class ImportBody(BaseModel):
    blob_b64: str = Field(min_length=1)
    passphrase: str = Field(min_length=8, max_length=1024)
    mode: ImportMode = ImportMode.MERGE


class RestartBody(BaseModel):
    scope: RestartScope = RestartScope.WORKER
    delay_seconds: float = Field(default=0.0, ge=0, le=3600)


def _host_parts(value: str | None) -> tuple[str, int | None] | None:
    if not value:
        return None
    try:
        parsed = urlsplit(f"//{value}")
        return (parsed.hostname or "").lower(), parsed.port
    except ValueError:
        return None


def _host_allowed(
    value: str | None,
    allowed_hosts: frozenset[str],
    expected_port: int | None,
) -> bool:
    parts = _host_parts(value)
    if parts is None:
        return False
    hostname, port = parts
    if hostname not in allowed_hosts:
        return False
    return expected_port is None or port in (None, expected_port)


def _origin_allowed(
    value: str | None,
    allowed_hosts: frozenset[str],
    expected_port: int | None,
    allowed_origins: frozenset[str],
) -> bool:
    if value is None:
        return True
    if value == "null" or not value:
        return False
    if value in allowed_origins:
        return True
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        return False
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        return False
    hostname = (parsed.hostname or "").lower()
    if hostname not in allowed_hosts:
        return False
    return expected_port is None or parsed.port in (None, expected_port)


def _cookie_value(header: str | None, name: str) -> str | None:
    if not header:
        return None
    jar = SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return None
    morsel = jar.get(name)
    return None if morsel is None else morsel.value


class LocalSecurityMiddleware:
    """Host/Origin/CSRF-защита локального API панели.

    Браузер не может выставить кастомный заголовок у cross-site simple request,
    а DNS rebinding отсекается проверкой Host. Для WebSocket токен берётся из
    HttpOnly/SameSite=Strict cookie, которую выставляет ``GET /api/session``.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        token: str,
        access_token: str | None,
        allowed_hosts: frozenset[str],
        port: int | None,
        allowed_origins: frozenset[str],
    ) -> None:
        self.app = app
        self.token = token
        self.access_token = access_token
        self.allowed_hosts = allowed_hosts
        self.port = port
        self.allowed_origins = allowed_origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        if not _host_allowed(headers.get("host"), self.allowed_hosts, self.port):
            await self._reject(scope, receive, send, 400, "invalid_host", "invalid Host header")
            return
        if not _origin_allowed(headers.get("origin"), self.allowed_hosts, self.port, self.allowed_origins):
            await self._reject(scope, receive, send, 403, "forbidden", "invalid Origin")
            return
        fetch_site = headers.get("sec-fetch-site")
        if fetch_site is not None and fetch_site not in {"same-origin", "none"}:
            await self._reject(scope, receive, send, 403, "forbidden", "cross-site request blocked")
            return

        path = str(scope.get("path", ""))
        if self.access_token is not None:
            if scope["type"] == "websocket":
                supplied = headers.get(ACCESS_HEADER) or _cookie_value(headers.get("cookie"), ACCESS_COOKIE)
                if supplied is None or not secrets.compare_digest(supplied, self.access_token):
                    await self._deny_websocket(send)
                    return
            elif path.startswith("/api/") and path != "/api/health":
                supplied = headers.get(ACCESS_HEADER)
                if supplied is None or not secrets.compare_digest(supplied, self.access_token):
                    await self._reject(scope, receive, send, 401, "unauthorized", "missing access token")
                    return

        if scope["type"] == "websocket":
            token = _cookie_value(headers.get("cookie"), SESSION_COOKIE)
            if token is None or not secrets.compare_digest(token, self.token):
                await self._deny_websocket(send)
                return
        else:
            method = str(scope.get("method", "GET")).upper()
            if method not in _SAFE_METHODS and path.startswith("/api/"):
                supplied = headers.get(CSRF_HEADER)
                if supplied is None or not secrets.compare_digest(supplied, self.token):
                    await self._reject(scope, receive, send, 403, "forbidden", "missing or invalid CSRF token")
                    return

        await self.app(scope, receive, send)

    @classmethod
    async def _reject(
        cls,
        scope: Scope,
        receive: Receive,
        send: Send,
        status: int,
        code: str,
        message: str,
    ) -> None:
        if scope["type"] == "websocket":
            await cls._deny_websocket(send)
            return
        await cls._deny(scope, receive, send, status, code, message)

    @staticmethod
    async def _deny(
        scope: Scope,
        receive: Receive,
        send: Send,
        status: int,
        code: str,
        message: str,
    ) -> None:
        response = JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})
        await response(scope, receive, send)

    @staticmethod
    async def _deny_websocket(send: Send) -> None:
        message: Message = {"type": "websocket.close", "code": 1008, "reason": "unauthorized"}
        await send(message)


def create_app(
    client: WorkerClient | None = None,
    settings_path: Path | None = None,
    *,
    allowed_hosts: tuple[str, ...] = tuple(LOCAL_HOSTS),
    port: int | None = None,
    allowed_origins: tuple[str, ...] = (),
    access_token: str | None = None,
) -> FastAPI:
    worker = client or WorkerClient(settings_path)
    csrf_token = secrets.token_urlsafe(32)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await worker.start()
        try:
            yield
        finally:
            await worker.stop()

    app = FastAPI(title="Lucrium Panel", version="0.1.0", lifespan=lifespan)
    app.state.worker = worker
    app.state.csrf_token = csrf_token
    app.add_middleware(
        LocalSecurityMiddleware,
        token=csrf_token,
        access_token=access_token,
        allowed_hosts=frozenset(item.lower() for item in allowed_hosts),
        port=port,
        allowed_origins=frozenset(allowed_origins),
    )

    @app.exception_handler(WorkerError)
    async def _worker_error(_: Any, exc: WorkerError) -> JSONResponse:
        status = 503 if exc.code in {"unavailable", "timeout"} else 400
        return JSONResponse(status_code=status, content={"error": {"code": exc.code, "message": exc.message}})

    @app.exception_handler(ValidationError)
    async def _validation_error(_: Any, exc: ValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "invalid_params", "message": str(exc)}},
        )

    # --- подключение ----------------------------------------------------------

    @app.get("/api/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/api/session")
    async def api_session(response: Response) -> dict[str, str]:
        """Выдаёт CSRF-токен и HttpOnly cookie для WebSocket-аутентификации."""
        response.set_cookie(
            SESSION_COOKIE,
            csrf_token,
            httponly=True,
            samesite="strict",
            path="/",
        )
        if access_token is not None:
            response.set_cookie(
                ACCESS_COOKIE,
                access_token,
                httponly=True,
                samesite="strict",
                path="/",
            )
        response.headers["Cache-Control"] = "no-store"
        return {"token": csrf_token}

    @app.get("/api/settings")
    async def get_settings() -> dict[str, Any]:
        return worker.settings.masked()

    @app.put("/api/settings")
    async def put_settings(body: SettingsBody) -> dict[str, Any]:
        token = body.token.strip() or worker.settings.token
        if not body.worker_url.strip():
            await worker.clear()
        else:
            await worker.reconfigure(
                worker_url=body.worker_url,
                token=token,
                verify_tls=body.verify_tls,
                tls_fingerprint=body.tls_fingerprint,
            )
        return worker.settings.masked()

    @app.delete("/api/settings")
    async def delete_settings() -> dict[str, bool]:
        await worker.clear()
        return {"ok": True}

    # --- состояние и команды --------------------------------------------------

    @app.get("/api/state")
    async def get_state() -> dict[str, Any]:
        return worker.info()

    @app.post("/api/command")
    async def run_command(body: CommandBody) -> dict[str, Any]:
        # Не превращаем локальный API в универсальный прокси к воркеру:
        # get_state/export_state/rotate_token/import_state и т.п. имеют
        # собственные endpoint'ы или не должны быть доступны браузеру.
        if body.method not in {command.value for command in SAFE_COMMANDS}:
            raise HTTPException(status_code=403, detail="command is not allowed via panel API")
        result = await worker.request(body.method, body.params)
        return {"result": result}

    @app.get("/api/logs")
    async def get_logs(
        scope: LogScope = LogScope.WORKER,
        plugin_id: str | None = None,
        level: LogLevel | None = None,
        limit: int = Query(default=100, ge=1, le=1000),
        cursor: int | None = Query(default=None, ge=0),
    ) -> dict[str, Any]:
        params = GetLogsParams(scope=scope, plugin_id=plugin_id, level=level, limit=limit, cursor=cursor)
        return await worker.request("get_logs", _params(params))

    @app.get("/api/events/history")
    async def get_event_history(
        session_id: str | None = None,
        kind: str | None = None,
        limit: int = Query(default=100, ge=1, le=1000),
        cursor: int | None = Query(default=None, ge=0),
    ) -> dict[str, Any]:
        params = GetEventsParams(session_id=session_id, kind=kind, limit=limit, cursor=cursor)  # type: ignore[arg-type]
        return await worker.request("get_events", _params(params))

    # --- аккаунты -------------------------------------------------------------

    @app.post("/api/accounts")
    async def add_account(body: AccountInput) -> dict[str, Any]:
        return await worker.request("add_account", {"account": to_wire(body)}, timeout=ACCOUNT_OPERATION_TIMEOUT)

    @app.patch("/api/accounts/{account_id}")
    async def update_account(account_id: str, body: AccountPatch) -> dict[str, Any]:
        params = UpdateAccountParams(
            account_id=account_id,
            label=body.label,
            credentials=(None if body.credentials is None else AccountCredentials.model_validate(body.credentials)),
            proxy=None if body.proxy is None else ProxyConfig.model_validate(body.proxy),
            clear_proxy=body.clear_proxy,
        )
        return await worker.request("update_account", _params(params), timeout=ACCOUNT_OPERATION_TIMEOUT)

    @app.delete("/api/accounts/{account_id}")
    async def remove_account(account_id: str) -> dict[str, Any]:
        return await worker.request("remove_account", {"account_id": account_id}, timeout=ACCOUNT_OPERATION_TIMEOUT)

    @app.post("/api/accounts/{account_id}/start")
    async def start_session(account_id: str) -> dict[str, Any]:
        return await worker.request("start_session", {"account_id": account_id}, timeout=ACCOUNT_OPERATION_TIMEOUT)

    @app.post("/api/accounts/{account_id}/stop")
    async def stop_session(account_id: str) -> dict[str, Any]:
        return await worker.request("stop_session", {"account_id": account_id}, timeout=ACCOUNT_OPERATION_TIMEOUT)

    @app.post("/api/accounts/{account_id}/call")
    async def call_client(account_id: str, body: CallBody) -> dict[str, Any]:
        params = CallClientParams(
            session_id=account_id,
            client_method=body.client_method,
            params=body.params,
        )
        return await worker.request("call_client", _params(params), timeout=CLIENT_CALL_TIMEOUT)

    # --- плагины --------------------------------------------------------------

    @app.post("/api/plugins/install")
    async def install_plugin(
        file: Annotated[UploadFile, File()],
        auto_start: Annotated[bool, Form()] = True,
        overwrite: Annotated[bool, Form()] = False,
    ) -> dict[str, Any]:
        archive = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(archive) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="архив больше 48 МБ")
        params = InstallPluginParams(
            archive_b64=base64.b64encode(archive).decode(),
            sha256=hashlib.sha256(archive).hexdigest(),
            auto_start=auto_start,
            overwrite=overwrite,
        )
        return await worker.request("install_plugin", _params(params), timeout=PLUGIN_OPERATION_TIMEOUT)

    @app.post("/api/plugins/{plugin_id}/config")
    async def set_plugin_config(plugin_id: str, body: ConfigBody) -> dict[str, Any]:
        params = SetPluginConfigParams(plugin_id=plugin_id, config=body.config)
        return await worker.request("set_plugin_config", _params(params), timeout=PLUGIN_OPERATION_TIMEOUT)

    @app.get("/api/plugins/{plugin_id}/schema")
    async def get_plugin_schema(plugin_id: str) -> dict[str, Any]:
        return await worker.request("get_plugin_schema", {"plugin_id": plugin_id}, timeout=ACCOUNT_OPERATION_TIMEOUT)

    @app.delete("/api/plugins/{plugin_id}")
    async def remove_plugin(plugin_id: str, purge_data: bool = False) -> dict[str, Any]:
        params = RemovePluginParams(plugin_id=plugin_id, purge_data=purge_data)
        return await worker.request("remove_plugin", _params(params), timeout=PLUGIN_OPERATION_TIMEOUT)

    # --- состояние целиком ----------------------------------------------------

    @app.post("/api/export")
    async def export_state(body: ExportBody) -> dict[str, Any]:
        params = ExportStateParams(passphrase=SecretStr(body.passphrase))
        return await worker.request("export_state", _params(params), timeout=STATE_TRANSFER_TIMEOUT)

    @app.post("/api/import")
    async def import_state(body: ImportBody) -> dict[str, Any]:
        params = ImportStateParams(
            blob_b64=body.blob_b64,
            passphrase=SecretStr(body.passphrase),
            mode=body.mode,
        )
        return await worker.request("import_state", _params(params), timeout=STATE_TRANSFER_TIMEOUT)

    @app.post("/api/token/rotate")
    async def rotate_token() -> dict[str, Any]:
        result = await worker.request("rotate_token", {}, timeout=ACCOUNT_OPERATION_TIMEOUT)
        token = str(result.get("token", ""))
        if not token:
            return result
        persisted = True
        warning: str | None = None
        try:
            await worker.reconfigure(
                worker_url=worker.settings.worker_url,
                token=token,
                verify_tls=worker.settings.verify_tls,
                tls_fingerprint=worker.settings.tls_fingerprint,
            )
        except Exception as exc:
            # Воркер уже отозвал старый токен. Не теряем новый токен из UI:
            # продолжаем сессию с ним и просим пользователя сохранить его.
            # Детали исключения оставляем в локальном логе, не в HTTP-ответе.
            logger.warning("new pairing token could not be persisted", exc_info=exc)
            await worker.adopt_token(token)
            persisted = False
            warning = "Новый токен не сохранён на диск. Сохраните его вручную."
        response = dict(result)
        response["persisted"] = persisted
        if warning:
            response["warning"] = warning
        return response

    @app.post("/api/restart")
    async def restart(body: RestartBody) -> dict[str, Any]:
        params = RestartParams(scope=body.scope, delay_seconds=body.delay_seconds)
        return await worker.request("restart", _params(params), timeout=ACCOUNT_OPERATION_TIMEOUT)

    @app.get("/api/update-check")
    async def update_check() -> dict[str, Any]:
        return await asyncio.to_thread(_check_update)

    # --- live-события ---------------------------------------------------------

    @app.websocket("/api/events")
    async def events(websocket: WebSocket) -> None:
        await websocket.accept()
        queue = worker.subscribe()
        try:
            await websocket.send_json({"kind": "snapshot", "data": worker.info()})
            while True:
                await websocket.send_json(await queue.get())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            worker.unsubscribe(queue)

    _mount_frontend(app)
    return app


def _check_update() -> dict[str, Any]:
    """Проверка обновлений панели по GitHub Releases (спека §9), кэш 1 час."""
    now = time.time()
    cached = _update_cache.get("payload")
    if cached is not None and now - float(_update_cache["at"]) < 3600:
        return dict(cached)
    from . import __version__

    payload: dict[str, Any] = {"current": __version__, "latest": None, "url": None, "update_available": False}
    try:
        request = urllib.request.Request(
            UPDATE_CHECK_URL,
            headers={"Accept": "application/vnd.github+json", "User-Agent": "lucrium-panel"},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            data = json.loads(response.read(256 * 1024))
        latest = str(data.get("tag_name", "")).lstrip("v")
        payload["latest"] = latest or None
        payload["url"] = data.get("html_url")
        payload["update_available"] = _is_newer_version(latest, __version__)
    except Exception as exc:
        payload["error"] = f"{type(exc).__name__}: {exc}"
    _update_cache["at"] = now
    _update_cache["payload"] = payload
    return dict(payload)


def _is_newer_version(candidate: str, current: str) -> bool:
    def parts(value: str) -> tuple[int, ...]:
        result: list[int] = []
        for token in value.split("."):
            number = ""
            for char in token:
                if not char.isdigit():
                    break
                number += char
            result.append(int(number) if number else 0)
        return tuple(result)

    if not candidate:
        return False
    left, right = parts(candidate), parts(current)
    width = max(len(left), len(right))
    return left + (0,) * (width - len(left)) > right + (0,) * (width - len(right))


def _params(model: BaseModel) -> dict[str, Any]:
    """``to_wire`` (раскрывает SecretStr) + method добавляет сам envelope."""
    payload = to_wire(model)
    payload.pop("method", None)
    return payload


def _mount_frontend(app: FastAPI) -> None:
    static_dir = Path(__file__).parent / "static"
    if static_dir.is_dir() and (static_dir / "index.html").is_file():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="frontend")
    else:

        @app.get("/")
        async def missing_frontend() -> dict[str, str]:
            return {
                "message": "Frontend не собран. Выполните `npm ci && npm run build` в каталоге frontend/.",
            }


__all__ = [
    "MAX_UPLOAD_BYTES",
    "AccountPatch",
    "CallBody",
    "CommandBody",
    "ConfigBody",
    "ExportBody",
    "ImportBody",
    "RestartBody",
    "SettingsBody",
    "create_app",
]
