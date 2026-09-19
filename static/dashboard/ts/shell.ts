// Shell behaviour shared by every dashboard page: the light/dark toggle
// (section 4 of the design system) and the details-based dropdown menus.
export {};

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
    return document.body.classList.contains('dark') ? 'dark' : 'light';
}

function labelToggle(button: HTMLButtonElement): void {
    const label = currentTheme() === 'dark' ? 'Toggle Light Mode' : 'Toggle Dark Mode';
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
}

function applyTheme(next: Theme): void {
    document.body.classList.remove('light', 'dark');
    document.body.classList.add(next);
    document.cookie = `theme=${next}; max-age=31536000; path=/; SameSite=Lax`;
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    labelToggle(button);
    button.addEventListener('click', () => {
        const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
        const apply = () => { applyTheme(next); labelToggle(button); };
        const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };
        if (doc.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(apply);
        else apply();
    });
}

// Dropdown menus are <details class="menu">: close on item click, outside click, or Escape.
const menus = Array.from(document.querySelectorAll<HTMLDetailsElement>('details.menu'));
if (menus.length) {
    document.addEventListener('click', (event) => {
        const target = event.target as Element;
        for (const menu of menus) {
            if (!menu.open) continue;
            if (target.closest('.menu-item') || !menu.contains(target)) menu.open = false;
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        for (const menu of menus) menu.open = false;
    });
}
