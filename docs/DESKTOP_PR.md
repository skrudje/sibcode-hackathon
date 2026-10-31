# feat: clarify desktop connectivity and isolate server sessions

Desktop теперь постоянно показывает адрес и состояние API, позволяет повторить проверку после сбоя и отличает недоступный сервер от необходимости входа. Успешная смена адреса очищает страницы и сессию; native-слой отклоняет запоздалые IPC-команды и ответы от прежнего подключения. Проверка того же адреса сохраняет вход, ошибка нового адреса сохраняет прежнее подключение.

Отмена сохранения CSV получает явное сообщение и позволяет повторить скачивание готовой выгрузки без нового экспорта. Для CSV/XLSX добавлена проверка размера до передачи в IPC. Карточки источников показывают период полноты и типы событий из API.

Добавлены изолированные UI-проверки ошибок подключения, отдельный сценарий с реальным API для импорта/экспорта/смены сервера и чек-лист приёмки установленных `.deb`/AppImage. Редактор настроек полноты ожидает API коллеги: endpoint обновления отсутствует в текущем контракте.

## Проверки

- Kali Linux 2025.2 x86_64; Node 24.22.1, npm 12.2.1.
- `npm ci`, `npm run generate:api` без diff типов, `npm run build` — PASS.
- `E2E_BROWSER_PATH=/usr/bin/chromium npm run test:desktop:ui` — 2 PASS; скриншоты React/IPC-контракта в `docs/screenshots/desktop`.
- Сценарий `npm run test:desktop` обнаруживается раннером, но не выполнялся без отдельного Compose-проекта.
- Rust tests/build и установленный Linux-клиент не проверялись: нет системных зависимостей, по уточнению пользователя сейчас только подготовка Linux-проверки. Проверка Windows исключена пользователем.

Подробные результаты и ограничения: [DESKTOP_VERIFICATION.md](DESKTOP_VERIFICATION.md). Критерий полного прохода в установленном приложении остаётся открытым до отдельной приёмки.

Целевая ветка PR: `main`. Исходная ветка: `feat/desktop-workflow`.

После настройки GitHub-авторизации:

```bash
git push -u origin feat/desktop-workflow
gh pr create --base main --head feat/desktop-workflow --title "feat: clarify desktop connectivity and isolate server sessions" --body-file docs/DESKTOP_PR.md
```
