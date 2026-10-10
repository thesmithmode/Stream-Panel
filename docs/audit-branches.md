# Проверка веток, 2026-10-08
- Репозиторий: https://github.com/thesmithmode/Stream-Panel
- Снимок main: 8c9f1c9e77ad5722e72c045419afff292a8fee05; dev: fad82ca5c1a16d255b20b6b53c1881c664b67f4c.
- Проверены все 16 удалённых веток: git branch -r, git cherry origin/main <branch>, сравнение дерева последней squash-ветки и diff отдельной правки.
- Полезные прежние функции уже включены в историю main; не требуется создавать их заново.
- codex-init, codex-init-grok, feat/ci-main-release-only, feat/da-redirect-127, feat/desktop-gui-launch, feat/linux-deb-migration, feat/live-ui-da-fixes, feat/server-profiles, fix/analytics-settings-spacing, fix/local-password-confirm, fix/post-v004-coverage-e2e, release-assets-slim не имеют отдельных неинтегрированных патчей по git cherry.
- fix/no-login-profile-switcher имеет три отличающихся commit ID из-за squash; её дерево полностью совпадает с main. Повторное слияние не требуется.
- feat/da-redirect-host-env содержит отдельный патч c73e5f2 для localhost/127.0.0.1 redirect. Текущий server.ts получает redirect из публичного origin; старый патч для VPS устарел.
- Заявленные завершения A/B/C из приложенного бэклога не обнаружены ни в main, ни в dev, ни в остальных удалённых ветках. Подробный статус: audit-product-requirements.md.
- Рабочая ветка feat/product-completion создана от dev. В ней сохранена серверная авторизация; main после PR8 удалил её.
- Незавершённые собственные правки сборщиков и core после остановки параллельной работы сохранены в локальном stash; не включены в проверенный код.
- Очистку удалённых веток выполнить после итоговых проверок и выпуска; main и dev сохранить и синхронизировать.
## Почему такое решение, даже если кажется странным:
- Основа разработки пока dev: на main удалён парольный вход, который нужен для приватного публичного сервера. При окончательном squash в main сохраняем актуальные необходимые изменения релиза и восстанавливаем защиту. Это не разрешение откатить историю или редактировать код прямо на main.
- git cherry не доказывает отсутствие реализации после squash. Поэтому fix/no-login-profile-switcher дополнительно проверена сравнением полного дерева.
