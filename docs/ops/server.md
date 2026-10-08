# Сервер и обновления

## Выбор VPS

Сначала запустить `bash ops/preflight.sh` только для чтения: Linux x86_64 + systemd, glibc ≥2.35, актуальный Python с tarfile.data_filter, ≥640 MiB свободной RAM, ≥3 GiB свободного диска, свободные 80/443/47831. Это пороги установки, не результат измерения имеющихся VPS. Желательно от 1 GiB RAM; лимиты служб: приложение 512 MiB/75% одного CPU, Caddy 128 MiB/20%. При занятых 80/443 подключать существующий прокси отдельным vhost после инвентаризации, не менять его вслепую.

Прямой SSH трёх предоставленных хостов из среды разработки недоступен (Network is unreachable). Ресурсы, дистрибутив, свободные порты и текущее содержимое сервера не проверены. Внешнее развёртывание пока не выполнено.

## Одноразовое развёртывание

1. Проверить DNS `stream-panel.<public-IP-with-hyphens>.sslip.io` и доступность входящих TCP 80/443. sslip.io — бесплатная внешняя DNS-зависимость, не купленный собственный домен. Проверить выдачу сертификата и лимиты ACME; при отказе остановиться, не переводить панель на публичный HTTP.
2. Получить Caddy binary Linux amd64 из официального релиза и проверить SHA256 по официальным checksums. Хранить локально для bootstrap; не устанавливать глобальный пакет/не менять системный Caddy.
3. Создать отдельную Ed25519 пару только для CI Stream Panel. Существующие пользовательские root-ключи не использовать для GitHub Actions. Публичный ключ — bootstrap, приватный — production secret GitHub.
4. От root: `bash ops/bootstrap.sh PUBLIC_IPV4 DEPLOY_PUBLIC_KEY_FILE VERIFIED_CADDY_BINARY`. Скрипт откажется при существующих каталогах/пользователях/службах или занятых портах. Ничего не удаляет и не меняет firewall/прочие приложения. При сбое bootstrap проверить созданные объекты перед повторным запуском, не удалять каталоги вслепую.
5. В GitHub environment `production` установить secrets: STREAM_PANEL_DEPLOY_HOST, STREAM_PANEL_DEPLOY_PORT, STREAM_PANEL_DEPLOY_KEY, STREAM_PANEL_DEPLOY_KNOWN_HOSTS. Последний — проверенный fingerprint из доверенного known_hosts; SSH не принимает новый ключ автоматически.
6. После живых проверок connectivity/backup/restore/rollback включить repository variable `STREAM_PANEL_PRODUCTION_ENABLED=true`. Успешный Quality gate для текущего main активирует Deploy server; workflow_dispatch позволяет повторить тот же проверенный commit. Пропущенный/красный CI и устаревший commit не деплоятся.
7. Создать аккаунты через `scripts/provision-accounts.mjs` из current release с DATA_DIR=/var/lib/stream-panel под пользователем stream-panel; JSON передать через stdin из закрытого файла. Файл затем удалить. Публичной регистрации нет; Гульназ может получить аккаунт сейчас и подключить свои сервисы позже.
8. Проверить HTTPS, неверный пароль, два браузера, изоляцию, reboot и настоящий эфир каждого сервиса. Проверить конфигурацию OAuth redirects после выбора URL.

Приложение живёт в /opt/stream-panel/releases/<sha>, current — атомарная ссылка. Секреты только /etc/stream-panel и /var/lib/stream-panel/profiles/<profile>/secrets.json. Данные только /var/lib/stream-panel/data.sqlite. Receiver /usr/local/sbin/stream-panel-receive — root-owned; deploy key ограничен единственным forced command и sudo без аргументов. Загруженный код никогда не исполняется как root.

## Что делает деплой

SHA256 + ограничения размера + безопасное извлечение tar (никаких ../, абсолютных путей, устройств или внешних symlink). flock запрещает два деплоя одновременно. Бинарник Node и production dependencies находятся внутри версии; pnpm на VPS не нужен. Native SQLite проверяется от service user до остановки старого приложения.

Maintenance отклоняет новые API-запросы. После остановки сборщиков Python SQLite backup сохраняет базу и настройки. Новая версия мигрирует профили и отвечает healthz правильным release SHA. Пока healthcheck не прошёл, сборщики не запускаются. Ошибка откатывает БД, настройки и symlink. Если даже старая версия не проходит health, marker остаётся и запись закрыта; нужна диагностика.

Физическую потерю питания, нехватку диска и недоступность провайдера нельзя исключить обещанием «всегда». Эти случаи должны оставлять проверяемую ошибку, а не тихо выдавать успех. На живом сервере дополнительно проверить искусственный неудачный healthcheck и очистку временных файлов. Bootstrap/receive проверены локальными сценариями; это не замена живого прогона.

## Supabase Storage

В существующем проекте создать PRIVATE bucket stream-panel-backups; пример SQL: ops/supabase-backup.sql. Не добавлять публичные SELECT policies. Backend проверяет private перед каждой загрузкой и использует отдельный серверный service-role key. Supabase DB password для Storage не подходит.

В /etc/stream-panel/server.env добавить STREAM_PANEL_SUPABASE_URL=https://PROJECT.supabase.co и STREAM_PANEL_SUPABASE_KEY_FILE=/etc/stream-panel/supabase-service-key. Файл ключа root:stream-panel 0640. Ключ AES из /etc/stream-panel/backup-key сохранить отдельно от VPS; без него восстановление невозможно. Никаких ключей в git/GitHub outputs/браузер.

Проверить удалённую загрузку, последние три объекта и восстановление в новый каталог. Не подключать другой проект автоматически: доступ к указанному пользователем проекту Stream Panel пока не подтверждён.
