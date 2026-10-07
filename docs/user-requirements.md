# Требования пользователя (суть)

Документ фиксирует договорённости по продукту **Stream Panel**. Репозиторий публичный: здесь пересказ смысла, без дословных цитат переписки.

Статус: продумывание / спецификация. Код продукта ещё не пишется.

## Цель

Локальная система аналитики стрима: понимать аудиторию как **людей** (не разрозненные ники на разных сервисах) — кто донатит, кто пишет, кто смотрит, как долго и когда именно.

Референс по духу (не клон): [Stream Tools](https://b1trat3.ru/products/stream-tools) — особенно идея связки событий и локальной аналитической базы. Виджеты OBS, розыгрыши и интерактив эфира **не** являются целью v1.

## Площадки и интеграции

- **Обязательно сейчас:** Twitch + DonationAlerts.
- **Заложить на будущее:** Streamer.bot как дополнительный источник событий (пока не установлен, но планируется).
- Прямые API площадок — основной путь; готовые инструменты (Streamer.bot и аналоги) — предпочтительный ускоритель, когда появятся.

## Сущность «человек»

- Одинаковый nick на Twitch и DonationAlerts → **сразу один Person** (auto-link по unique `matchKey`).
- Разные ники («донатер X = зритель Y») → **обязательный ручной merge**: прошлые и будущие донаты/активность в одном Person.
- Разъединение ошибочных склеек — undo / split (как уже задокументировано).
- Неоднозначные имена (несколько кандидатов) → только предложения, без автосклейки.

## Хранение данных

- Данные **обязательно локально** на машине стримера.
- Желателен **бесплатный удалённый бэкап / sync** базы (на случай потери диска), без обязательной «облачной аналитики» как единственного режима.

## Платформы и режим работы

- Кроссплатформа: **Windows и Linux** (включая сбор статистики со стрим-машины на Linux).
- Приложение должно **стабильно работать всё время стрима** (долгоживущий процесс, автопереподключение к API).

## Presence и детализация

Нужна максимально достоверная картина:

- кто сейчас смотрит;
- как долго смотрел;
- когда пришёл и ушёл;
- когда и что написал;
- частота сообщений;
- минуты просмотра с разбивкой **вплоть до конкретной минуты конкретной даты** (пример уровня детализации: смотрел ли человек X в понедельник DD.MM в 12:03).

Ограничения Twitch API и способ закрытия требования описаны в [tech-spec.md](./tech-spec.md) — честно, без обещаний «телеметрии как у платформы».

## UI / аналитика

- Ориентир: широкий набор экранов в духе аналитики Stream Tools («скорее все», топ-3 экрана пользователь не выделял).
- Приоритизация экранов — на этапе MVP (см. PRD).

## Стек

Пользователь делегировал выбор стека команде. Выбор и обоснование — в [tech-spec.md](./tech-spec.md).

## Вне скоупа (пока)

- Клон OBS-виджетов Stream Tools (мультичат-оверлей, таймеры, колесо, аукцион, эмулятор ввода и т.п.).
- YouTube (в т.ч. видео «Аналитический раздел Stream Tools») как источник требований или интеграция — продукт v1 = **Twitch + DonationAlerts** only.
- Обязательный multi-tenant SaaS.
- Гарантия учёта анонимных / незалогиненных зрителей без присутствия в chatters.

---

## Implementation decisions

Дата: **2026-10-07** (МСК).

- Наблюдение в chatters: опрос **каждые 60–120 с** (default 60); успешный опрос закрывает интервал с прошлого успешного, а не одну минуту по времени завершения.
- Неполный/сбойный опрос ≠ «человека не было».
- Удалённые модерацией сообщения: хранить оригинал, помечать redacted, в интерфейсе скрывать по умолчанию; действие ограничено текущей сессией (или узким окном).
- Рабочая ветка для клонирования ранней версии: `codex-init-grok` (не `codex-init`). Интеграция — в `dev`, релизы — в `main`.

- Person auto-link (**KEEP**): identical Twitch↔DA nick (unique `matchKey`) → immediate auto-link into one Person + owner bind on Twitch login. Ambiguous names stay suggestions only. Not suggestions-only for unique nick.
- Manual merge **required** for different nicks («донатер X = зритель Y»): merges all past **and** future donations/activity into one Person; undo/split unchanged.
- Twitch definitive auth failure HTTP **400/401** → clear tokens + `TWITCH_REAUTH_REQUIRED`; UI must show **explicit** reauth («Войди снова»), not a silent/connected look. Do **not** advance-warn about ~30-day public refresh expiry (useless beforehand).
- YouTube / Stream Tools analytics video: **out of scope** (Twitch + DA only).
- Bot filter in analytics (configurable + well-known); Litestream path documented; Streamer.bot stub only until P3.
- Durable rejection of merge candidates and scoped owner rules with TTL stay **P1** (not implemented in this readiness tick): needs schema + API + UI + coverage; offline suggestions + manual merge are enough to start live validation. See tech-spec Implementation decisions §16.

