function currentTheme() {
    return document.body.classList.contains('dark') ? 'dark' : 'light';
}
function labelToggle(button) {
    const label = currentTheme() === 'dark' ? 'Toggle Light Mode' : 'Toggle Dark Mode';
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
}
function applyTheme(next) {
    document.body.classList.remove('light', 'dark');
    document.body.classList.add(next);
    document.cookie = `theme=${next}; max-age=31536000; path=/; SameSite=Lax`;
}
for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    labelToggle(button);
    button.addEventListener('click', () => {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        const apply = () => { applyTheme(next); labelToggle(button); };
        const doc = document;
        if (doc.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
            doc.startViewTransition(apply);
        else
            apply();
    });
}
// Dropdown menus are <details class="menu">: close on item click, outside click, or Escape.
const menus = Array.from(document.querySelectorAll('details.menu'));
if (menus.length) {
    document.addEventListener('click', (event) => {
        const target = event.target;
        for (const menu of menus) {
            if (!menu.open)
                continue;
            if (target.closest('.menu-item') || !menu.contains(target))
                menu.open = false;
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape')
            return;
        for (const menu of menus)
            menu.open = false;
    });
}
export {};
