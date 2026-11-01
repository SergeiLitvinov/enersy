# Проверка структуры БД v1

Прежние bootstrap/legacy-инструменты удалены по решению пользователя 2026-11-01 до первого выпуска. Вместо них используется единый [baseline v1](./database.md). Исторические схемы автоматически не обновляются и не получают доверенные checksum задним числом.

```powershell
./scripts/database/Audit-EnersyDatabase.ps1
./scripts/database/Audit-EnersyDatabase.ps1 -Catalog
```

Команда выполняется внутри Docker-образа API до запуска HTTP и миграций. Формат 1, scope `database-v1-integrity`, readOnly=true. Поля: версия источника и БД, dirty, агрегированные `counts`, список `findings` и status. Состояние `no_findings_in_audited_scope` относится только к наличию текущих таблиц, истории SHA, проверенным ограничениям и включённым triggers. Пустая БД получает review_required и остаётся пустой. Ошибки SQL не превращаются в успешный частичный отчёт.

Личные строки и имена пользовательских расширений в JSON не включаются. Проверка каталога остаётся отдельной: [справочники](./catalog-audit.md). Карты legacy-моделей и demo-владельцев больше не являются частью CLI; действующие аккаунты и проектные роли не выводятся из старых ID.

## Исторические ссылки

Якоря ниже оставлены для датированных отчётов; они не являются действующими инструкциями.

<a id="legacy-owner-map"></a>
<a id="legacy-owner-verification"></a>
<a id="legacy-reference-checks"></a>
<a id="legacy-incoming-foreign-keys"></a>
<a id="legacy-identity-checks"></a>
