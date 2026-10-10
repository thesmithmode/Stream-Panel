# Сервер и обновления

## Подтверждённая инфраструктура

Последняя read-only проверка подтвердила Ubuntu 24, около 3,4 GiB RAM, около 2 GiB доступной RAM и около 16 GiB свободного диска. Порты 80/443 заняты существующим Traefik; его конфигурация находится в `/root/traefik/config`. Проверенная сеть: bridge `172.21.0.1`, proxy `172.21.0.2`. Публичный адрес в документацию не записывается.

Bootstrap проверяет не менее 640 MiB доступной RAM, glibc ≥2.35, Python с `tarfile.data_filter` и не менее 3 GiB свободного места в `/opt`. Проверенный свободный диск превышает порог; перед запуском bootstrap нужно повторить read-only preflight. Проверка конфигурации не означает, что приложение уже установлено: deployment ещё не выполнен, он ожидает завершения CI и проверки артефакта.

## Первичная настройка

1. Повторить preflight по ресурсам и проверить, что topology существующего Traefik не изменилась. Bootstrap добавляет отдельный маршрут в `/root/traefik/config/stream-panel.yml`; он не заменяет текущие proxy-конфигурацию, сеть или контейнер.
2. Подготовить отдельный Ed25519 deploy key. В GitHub environment `production` задать `STREAM_PANEL_BOOTSTRAP_KEY`, `STREAM_PANEL_DEPLOY_HOST`, `STREAM_PANEL_DEPLOY_PORT`, `STREAM_PANEL_DEPLOY_KNOWN_HOSTS`, `STREAM_PANEL_DEPLOY_PUBLIC_KEY`, `STREAM_PANEL_BACKUP_KEY`, `STREAM_PANEL_ACCOUNTS`, а также variables `STREAM_PANEL_BRIDGE_IP=172.21.0.1` и `STREAM_PANEL_PROXY_IP=172.21.0.2`. Known hosts должен содержать проверенный ключ сервера.
3. Дождаться зелёного Quality gate для точного SHA текущей `main`. Quality gate один раз собирает Linux amd64 server bundle, связывает его с SHA и публикует CI artifact на 30 дней. Bootstrap и последующий Deploy server получают тот же artifact и проверяют его checksum; они не собирают bundle повторно.
4. Запустить workflow Bootstrap private server вручную на текущей `main`. Он проверит успешный gate этого SHA, состояние сервера и SSH-настройки до изменений, затем создаст изолированную службу и маршрут Traefik. При ошибке сверить вывод с текущей инфраструктурой; не удалять системные объекты вручную без проверки их владельца.
5. Если облачные копии нужны при первичной настройке, задать repository variable `STREAM_PANEL_CLOUD_BACKUP_ENABLED=true`, variable `STREAM_PANEL_SUPABASE_URL` и secret `STREAM_PANEL_SUPABASE_KEY`. По умолчанию облачные копии выключены: аккаунты создаются, а зашифрованная резервная копия проверяется локально. URL и key задаются парой; частичная конфигурация блокирует bootstrap до SSH.
6. Перед первым production deployment выполнить живые проверки HTTPS, закрытого API, учётных записей, резервной копии и восстановления. Только после этого включить `STREAM_PANEL_PRODUCTION_ENABLED=true`. Deploy server допускает только точный текущий SHA `main` с успешным Quality gate.

Аккаунты передаются в bootstrap через `STREAM_PANEL_ACCOUNTS` и provision-ятся из закрытого payload. Пароли не записывать в логи, argv или репозиторий. Служба использует `/opt/stream-panel/releases/<sha>` и атомарную ссылку `current`; SQLite и настройки профилей находятся в `/var/lib/stream-panel`. Загруженный код выполняется только от service user. Deploy key ограничен receiver-командой.

## Деплой и откат

CI artifact содержит Node runtime и production dependencies. Receiver сверяет SHA256, ограничения размера и безопасно извлекает архив, отвергая абсолютные пути, `..`, устройства и внешние symlink. Параллельные операции блокируются через flock. До остановки текущей версии native SQLite проверяется от service user.

Deploy переводит API в maintenance, останавливает сборщики и сохраняет SQLite вместе с настройками. Новая версия должна мигрировать профили и ответить на healthcheck с правильным release SHA до запуска сборщиков. Ошибка возвращает БД, настройки и ссылку `current`. Если старая версия тоже не проходит healthcheck, maintenance marker остаётся на месте для диагностики.

Почему такое решение, даже если кажется странным:

Bootstrap и Deploy используют один архив Quality gate, потому что повторная сборка одного SHA не гарантирует тот же checksum. Использование проверенного артефакта связывает production с ровно теми байтами, которые прошли CI.

На живом сервере отдельно подтвердить обновление и rollback, восстановление backup в новый каталог, перезапуск службы и поведение при недоступности сети. Read-only инвентаризация и CI не подтверждают эти эксплуатационные сценарии.

## Резервные копии

Локальные encrypted backups включены всегда и проверяются при bootstrap. В них входят обе профильные схемы SQLite и настройки подключений; AES-256-GCM ключ хранится отдельно от данных. Потеря ключа делает восстановление невозможным.

Supabase Storage подключается по желанию. Для включения создать PRIVATE bucket `stream-panel-backups`, настроить repository variable `STREAM_PANEL_CLOUD_BACKUP_ENABLED=true`, variable `STREAM_PANEL_SUPABASE_URL` и secret `STREAM_PANEL_SUPABASE_KEY`. Backend проверяет приватность bucket, загружает копию и проверяет её наличие; ошибка облачной загрузки завершает проверку bootstrap ошибкой, сохраняя локальную копию для диагностики. При выключенной опции URL и key не передаются в bootstrap.

Ключ AES хранить отдельно от VPS. Service key хранится только как root-owned файл `/etc/stream-panel/supabase-key` и не передаётся браузеру, git или workflow output. Проверить загрузку, ротацию последних трёх объектов и restore на живой инфраструктуре до включения production deployment.
