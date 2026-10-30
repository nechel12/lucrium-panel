"""Настройки панели: адрес воркера и pairing-токен (локально, 0600).

Панель не хранит конфигов аккаунтов/плагинов — только параметры подключения
к воркеру (спека §0: «панель ничего не хранит важного»).
"""

from __future__ import annotations

import contextlib
import json
import os
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from platformdirs import user_config_dir

APP_NAME = "Lucrium"
APP_AUTHOR = "Lucrium"


def default_settings_path() -> Path:
    return Path(user_config_dir(APP_NAME, APP_AUTHOR)) / "panel.json"


@dataclass(frozen=True, slots=True)
class PanelSettings:
    worker_url: str = ""
    token: str = ""
    verify_tls: bool = False

    @property
    def configured(self) -> bool:
        return bool(self.worker_url and self.token)

    def normalized_url(self) -> str:
        """``1.2.3.4:8443`` → ``wss://1.2.3.4:8443``; схема сохраняется, если задана."""
        url = self.worker_url.strip().rstrip("/")
        if not url:
            return ""
        if "://" not in url:
            url = f"wss://{url}"
        return url

    def with_connection(self, *, worker_url: str, token: str, verify_tls: bool = False) -> PanelSettings:
        return replace(self, worker_url=worker_url.strip(), token=token.strip(), verify_tls=verify_tls)

    @classmethod
    def load(cls, path: Path | None = None) -> PanelSettings:
        file = path or default_settings_path()
        if not file.is_file():
            return cls()
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return cls()
        return cls(
            worker_url=str(data.get("worker_url", "")),
            token=str(data.get("token", "")),
            verify_tls=bool(data.get("verify_tls", False)),
        )

    def save(self, path: Path | None = None) -> Path:
        file = path or default_settings_path()
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")
        with contextlib.suppress(OSError):
            os.chmod(file, 0o600)
        return file

    def masked(self) -> dict[str, object]:
        """Для отдачи в UI: токен никогда не возвращается целиком."""
        token = self.token
        tail = token[-4:] if len(token) > 8 else ""
        return {
            "worker_url": self.worker_url,
            "configured": self.configured,
            "token_hint": f"…{tail}" if tail else "",
            "verify_tls": self.verify_tls,
        }


__all__ = ["APP_AUTHOR", "APP_NAME", "PanelSettings", "default_settings_path"]
