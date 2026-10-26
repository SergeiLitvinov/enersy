import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'ru-RU',
  title: 'Enersy',
  description: 'Открытая платформа моделирования энергосистем — руководство и справочник разработки',
  cleanUrls: false,
  lastUpdated: false,
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Руководство', link: '/guide/quickstart' },
      { text: 'Разработка', link: '/development/architecture' },
      { text: 'Код', link: '/reference/' },
      { text: 'Программа', link: 'http://localhost' }
    ],
    sidebar: [
      { text: 'Работа с программой', items: [
        { text: 'Возможности и границы', link: '/guide/capabilities' },
        { text: 'Запуск', link: '/guide/quickstart' },
        { text: 'Схемы и каталог', link: '/guide/editor' },
        { text: 'Исследования и версии', link: '/guide/studies' },
        { text: 'Расчёт и ошибки', link: '/guide/calculation' }
      ] },
      { text: 'Разработчикам', items: [
        { text: 'Архитектура', link: '/development/architecture' },
        { text: 'Реестр дефектов', link: '/development/defects' },
        { text: 'Численная проверка', link: '/development/numerical-validation' },
        { text: 'Приёмка A01–A08', link: '/development/calculation-acceptance' },
        { text: 'Разреженные расчёты', link: '/development/sparse-compute' },
        { text: 'Профиль хранения', link: '/development/storage-profile' },
        { text: 'Производительность редактора', link: '/development/editor-performance' },
        { text: 'Пользователи и сессии', link: '/development/sessions' },
        { text: 'Проектный каталог', link: '/development/project-catalog' },
        { text: 'Обновление базы', link: '/development/database' },
        { text: 'Обновление PostgreSQL', link: '/development/postgres-upgrades' },
          { text: 'Аудит старой базы', link: '/development/bootstrap-audit' },
          { text: 'Сверка каталога', link: '/development/catalog-audit' },
        { text: 'Вычислительные движки', link: '/development/compute-backends' },
        { text: 'Граница Julia↔Rust', link: '/development/native-jacobian' },
        { text: 'Управление расчётом', link: '/development/execution-control' },
          { text: 'Режимные ограничения', link: '/development/operating-limits' },
          { text: 'Версии исследования', link: '/development/studies' },
        { text: 'Два вида схемы', link: '/development/diagram-views' },
        { text: 'Документация и CI', link: '/development/documentation' },
        { text: 'Происхождение графики и данных', link: '/development/asset-provenance' },
        { text: 'Правила кодирования', link: '/generated/rules' },
        { text: 'Анализ проекта', link: '/generated/review' },
        { text: 'Проверка реализации', link: '/generated/implementation' },
        { text: 'История проверок', link: '/development/verification-history' },
        { text: 'План работ', link: '/generated/todo' }
      ] },
      { text: 'Справочник', items: [
        { text: 'Обзор модулей', link: '/reference/' },
        { text: 'HTTP-контракты', link: '/reference/http' },
        { text: 'TypeScript API', link: '/api/typescript/index.html' },
        { text: 'Все исходники', link: '/generated/code/' }
      ] }
    ],
    search: { provider: 'local', options: { locales: { root: { translations: {
      button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск в документации' },
      modal: { noResultsText: 'Ничего не найдено', resetButtonTitle: 'Очистить', footer: { selectText: 'выбрать', navigateText: 'перейти', closeText: 'закрыть' } }
    } } } } },
    outline: { label: 'На странице', level: [2, 3] },
    docFooter: { prev: 'Назад', next: 'Далее' },
    darkModeSwitchLabel: 'Тема',
    sidebarMenuLabel: 'Разделы',
    returnToTopLabel: 'Наверх',
    socialLinks: [{ icon: 'github', link: 'https://github.com/SergeiLitvinov/enersy' }],
    footer: { message: 'Возможности расчёта проверяйте по реестру сервиса. Экспериментальный результат требует независимой проверки.' }
  }
});
