# Lucrium Panel

> **Проект в стадии разработки и тестирования.** Панель публикуется как exe на
> GitHub Releases, но до версии 1.0 контракт с воркером меняется без обратной
> совместимости — версии панели и воркера нужно брать рядом. Помощь с
> тестированием и находками очень нужна: [CONTRIBUTING.md](CONTRIBUTING.md).
> Для реальных продаж панель пока **не готова**: подключать стоит только
> тестовые учётные записи площадок.

[![CI](https://github.com/nechel12/lucrium-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/nechel12/lucrium-panel/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nechel12/lucrium-panel)](https://github.com/nechel12/lucrium-panel/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.12%2B-blue)](pyproject.toml)

Десктоп-панель управления воркером: React-фронтенд + локальный Python-бэкенд
(FastAPI на `127.0.0.1`), который держит одно WSS-соединение с воркером.
Панель — «удалённый пульт»: все конфиги и сессии живут на VPS, панель можно
закрыть (спека §0).

## Быстрый старт (из исходников)

Репозитории должны лежать рядом (`lucrium-panel` и `lucrium-protocol`):

```bash
git clone https://github.com/nechel12/lucrium-protocol
git clone https://github.com/nechel12/lucrium-panel
cd lucrium-panel

# 1. соберите фронтенд
cd frontend && npm ci && npm run build && cd ..

# 2. запустите панель
uv sync
uv run lucrium-panel            # откроет http://127.0.0.1:8765 в браузере
uv run lucrium-panel --window   # нативное окно (pywebview, EdgeChromium)
```

При первом запуске панель попросит адрес воркера и pairing-токен (его печатает
`install.sh` на VPS). Токен хранится в профиле пользователя (`panel.json` в
каталоге `platformdirs`: `%APPDATA%` на Windows, `~/.config` на Linux) и **не
попадает в браузер/webview**: фронтенд общается только с локальным backend. На
POSIX файл создаётся с правами `0600`; на Windows доступ регулирует ACL
профиля пользователя, отдельной защиты от процесса под тем же пользователем
нет. Смена адреса воркера требует ввести токен заново — старый на новый хост
не отправляется.

## Сборка exe (Windows)

```powershell
cd frontend; npm ci; npm run build; cd ..
uv sync --extra desktop --extra build
uv run pyinstaller packaging/lucrium-panel.spec --noconfirm
# dist/Lucrium.exe
```

GitHub Actions собирает `Lucrium.exe` на каждый PR (artifact) и прикладывает
к GitHub Release по тегу `v*`.

> **Антивирусы:** one-file PyInstaller часто даёт false positive. Для релизов
> закладывайте подпись кода (сертификат) или сборку Nuitka; до этого
> предупреждайте пользователей в release notes.

## Что умеет

| Экран | Возможности |
|---|---|
| Подключение | адрес + токен, проверка TLS-сертификата, отключение только с fingerprint |
| Дашборд | статус воркера, сессии/плагины, аккаунты (добавить/старт/стоп/удалить), живой поток событий с фильтром по аккаунту и историей из SQLite |
| Лоты | список и базовое управление через клиент aiosellers: цена (PlayerOK/GGsel), публикация/удаление (PlayerOK), удаление (FunPay) |
| Плагины | установка zip, удаление, авто-форма настроек из JSON Schema манифеста, показ разрешений (`accounts`/`network`/`finance`) и подтверждение при их расширении |
| Журнал | логи воркера и плагинов, фильтры по уровню/плагину, автообновление |
| Настройки | ротация токена, экспорт/импорт состояния (`.lcs`), рестарт воркера/сессий, проверка обновлений |

## Архитектура

```
React (Vite) ──HTTP/WS──► FastAPI 127.0.0.1 ──WSS──► Lucrium Worker :8443
                              │
                              └── panel.json (url + token, 0600)
```

- `worker_client.py` — WSS-клиент: реконнект с backoff, корреляция запросов,
  кэш последнего `state`, подписка на события.
- `api.py` — REST/WS для фронтенда; все команды проходят через
  `lucrium-protocol` (валидация params/result).
- Секреты (`SecretStr`) раскрываются только на пути панель → воркер через
  `to_wire`. Обратный путь — маски: `get_state` кредов не содержит вовсе, а
  полные значения отдаёт отдельная команда `reveal_credentials`, и интерфейс
  панели их не показывает.

## Разработка

```bash
uv sync
uv run ruff check . && uv run ruff format --check .
uv run mypy src
uv run pytest

cd frontend
npm ci
npm run dev        # Vite dev-server с прокси на 127.0.0.1:8765
```

Backend запускается отдельно: `uv run lucrium-panel --no-browser`, затем
открывается напечатанный URL с `#access=...` (голый `http://127.0.0.1:8765` не получит
доступ к API).

## Безопасность

Проверка релизных тегов и exe описана в [SECURITY.md](SECURITY.md).

- Backend слушает только loopback; `--host` с внешним адресом отклоняется.
- Все mutating-запросы требуют CSRF-токен (`/api/session` + заголовок
  `X-Lucrium-CSRF`), WebSocket — HttpOnly/SameSite=Strict cookie; Host и Origin
  проверяются, cross-site simple requests блокируются.
- При запуске генерируется одноразовый access-токен и открывается URL вида
  `http://127.0.0.1:8765/#access=...`. Он не уходит на сервер в HTTP-запросе
  (fragment), фронтенд сохраняет его в sessionStorage и шлёт заголовком
  `X-Lucrium-Access`; cookie нужна WebSocket. Голый `http://127.0.0.1:8765`
  без токена доступа к API не получит — нужна ссылка из консоли.
- Access-токен и CSRF защищают от других локальных пользователей и браузерных
  атак, но не от процесса того же пользователя ОС: такой процесс может читать
  URL/сессию. На многопользовательской машине запускайте панель под отдельной
  учётной записью ОС.
- Pairing-токен не отдаётся фронтенду (в `/api/settings` только хвост для UI).
- TLS проверяется по умолчанию. Для самоподписанного сертификата укажите
  SHA256 fingerprint из `install.sh` — это pinning без отключения проверки.
  `ws://` для не-loopback адресов запрещён.
- Экспорт состояния шифруется паролем пользователя (PBKDF2-SHA256 600k +
  Fernet) на стороне воркера; в дамп входят и артефакты плагинов.

## Статус

v1 (рабочая оболочка): подключение по pairing-токену, дашборд, аккаунты и
сессии, лента событий, лоты, плагины с авто-формой, журнал, экспорт/импорт,
ротация токена, сборка exe в CI. Не хватает для «production для чужих рук»:
подписи кода exe (сейчас только cosign, отсюда false positive антивирусов),
нескольких профилей подключения (реализован один текущий), тестов на живых
площадках и согласованной связки версий панель/воркер.

## Лицензия

AGPL-3.0 — см. [LICENSE](LICENSE).
