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
        { text: 'Запуск', link: '/guide/quickstart' },
        { text: 'Схемы и каталог', link: '/guide/editor' },
        { text: 'Расчёт и ошибки', link: '/guide/calculation' }
      ] },
      { text: 'Разработчикам', items: [
        { text: 'Архитектура', link: '/development/architecture' },
        { text: 'Обновление базы', link: '/development/database' },
        { text: 'Вычислительные движки', link: '/development/compute-backends' },
        { text: 'Два вида схемы', link: '/development/diagram-views' },
        { text: 'Документация и CI', link: '/development/documentation' },
        { text: 'Правила кодирования', link: '/generated/rules' },
        { text: 'Анализ проекта', link: '/generated/review' },
        { text: 'Проверка реализации', link: '/generated/implementation' },
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
