# Проверка данных, 2026-10-08
- Проверен только Supabase проект eyverhyrhibwyiipgozn, название Stream Panel, статус ACTIVE_HEALTHY, регион eu-west-1. Streetfood не открывался.
- В public: sp_persons=1, sp_identities=1, sp_events=1, sp_presence_polls=0, sp_presence_members=0. Это точные count(*), не оценки каталога.
- Единственное событие: Twitch chat.message, occurred_at_ms=1; последний synced_at=2026-10-07T11:41:18.176714Z. Полноценная история эфиров не подтверждена.
- storage.buckets и storage.objects пусты. Шифрованной резервной копии SQLite в Storage нет.
- Полный экспорт пяти старых таблиц сохранён локально в игнорируемом secrets/supabase-legacy-export.json; SHA256 11BB57C9E2919CB1A62BF6F3A7DE5B04F843BBAE1EBF6E9AA5DD2AC482F16702. Содержимое экспорта не хранится в Git.
- Подтверждена уязвимость старых таблиц: RLS был выключен; anon имел SELECT/INSERT/UPDATE/DELETE на все пять таблиц.
- Применена protect_legacy_stream_panel_exports: RLS включён, права anon/authenticated отозваны, данные сохранены; service_role SELECT сохранён. SQL находится в ops/supabase-privacy.sql.
- Повторная проверка: пять таблиц с RLS=true, anon CRUD=false, authenticated SELECT=false, service_role SELECT=true. После изменения counts остались 1/1/1/0/0.
- Для переноса настоящей истории необходима исходная SQLite с Linux. Для облачных копий необходим серверный service_role key именно этого проекта; MCP его не предоставляет.
## Почему такое решение, даже если кажется странным:
- У аккаунтов панели своя серверная авторизация; Supabase authenticated не означает один из двух разрешённых аккаунтов панели. Поэтому старый экспорт закрыт и для anon, и для произвольных Supabase authenticated. Доступ service_role с сервера сохранён.
- Старые таблицы не удаляем и не заменяем: сохранённый экспорт нужен для сопоставления с настоящей Linux-базой. Отсутствие копии не подменяем тестовыми данными.
