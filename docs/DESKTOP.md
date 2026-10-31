# Desktop для Linux и Windows

## Архитектура

Tauri 2 упаковывает React-интерфейс в нативное приложение. Сборка содержит локальные HTML/CSS/JS и Rust-слой подключения, а не открывает удалённый сайт. Клиент подключается к общей серверной платформе: FastAPI → PostgreSQL, worker/dispatcher → Valkey. Пользователю установленного клиента не нужны Python, Node.js и Rust.

Для локальной разработки сервер запускается через Docker Compose. Для совместной работы сотрудников нужен один доступный сервер с HTTPS и индивидуальными учётными записями. Установщик не содержит PostgreSQL, Docker или реальные пароли. Полностью автономный режим и синхронизация нескольких локальных баз в текущую архитектуру не входят.

Запросы desktop выполняет native HTTP-клиент Rust с cookie-сессией в памяти. Webview получает только относительные API-запросы; произвольные внешние адреса и редиректы запрещены. При смене адреса сервера сессия сбрасывается. Адрес сервера сохраняется отдельно от пароля. HTTP разрешён только для loopback-разработки; удалённый сервер требует HTTPS.

В браузере остаются same-origin запросы через Nginx. В desktop нет необходимости ослаблять CORS или CSRF backend: native-слой передаёт origin выбранного сервера, который должен присутствовать в его `ALLOWED_ORIGINS`.

## Зависимости разработчика

Для всех ОС: Git, Node.js 24 LTS, Rust stable через rustup. Зависимости JS устанавливаются в `apps/web` командой `npm ci`; версии Rust фиксируются в Cargo.lock. Актуальные требования Tauri: https://v2.tauri.app/start/prerequisites/.

Linux (Debian/Ubuntu/Kali):

```bash
sudo apt-get update
sudo apt-get install build-essential curl pkg-config libwebkit2gtk-4.1-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev patchelf
```

Windows: Microsoft C++ Build Tools с компонентом Desktop development with C++, WebView2 Runtime, Rust target `x86_64-pc-windows-msvc`. Используйте PowerShell; сервер запускается в Docker Desktop с Linux containers/WSL2.

## Запуск из исходников

Из корня репозитория подготовьте `.env` по `.env.example`, затем:

```bash
docker compose up --build -d --wait
cd apps/web
npm ci
npm run desktop:dev
```

Сервер по умолчанию — `http://127.0.0.1:5180`. Dev-окно интерфейса использует отдельный порт 1420, поэтому не конфликтует с Nginx. В настройках подключения можно указать другой сервер. Учётная запись для локальной демонстрации описана в README.

## Сборка установщика

Из `apps/web`:

```bash
npm run desktop:build
```

Linux собирается на Linux, Windows — на Windows. Результаты находятся в `apps/web/src-tauri/target/release/bundle/`. Windows: NSIS `.exe`. Linux: `.deb` и AppImage. Нельзя считать Windows-сборку проверенной по одному успешному Linux-билду.

Workflow `.github/workflows/desktop.yml` собирает обе платформы и сохраняет установщики как Actions artifacts. Он не публикует GitHub Release автоматически. Проверка подписи Windows и автообновления требуют отдельной настройки для выпуска; прототип не содержит сертификатов.

## Native UX

Покупки и профили остаются на сервере. CSV выгружается через диалог «Сохранить как» с authenticated-запросом; пароль и cookie не попадают в URL скачивания. При недоступном backend приложение показывает ошибку подключения и даёт изменить адрес. Для проверки browser-режима сохраняются существующие E2E.
