let _menuSeq = 0;

export class CustomDropdown {
    private select: HTMLSelectElement;
    private wrapper!: HTMLDivElement;
    private trigger!: HTMLButtonElement;
    private menu!: HTMLDivElement;
    private _observer: MutationObserver;
    private _onDocumentClick!: (e: MouseEvent) => void;

    constructor(selectEl: HTMLSelectElement) {
        this.select = selectEl;
        this._build();
        this._bindEvents();
        this._observer = new MutationObserver(() => this.sync());
        this._observer.observe(this.select, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['disabled'],
        });
        this.sync();
    }

    _build(): void {
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'custom-dropdown';
        if (this.select.id) this.wrapper.dataset.for = this.select.id;

        this.trigger = document.createElement('button');
        this.trigger.className = 'custom-dropdown-trigger';
        this.trigger.type = 'button';
        this.trigger.setAttribute('aria-haspopup', 'listbox');
        this.trigger.setAttribute('aria-expanded', 'false');

        this.menu = document.createElement('div');
        this.menu.className = 'custom-dropdown-menu';
        this.menu.setAttribute('role', 'listbox');
        this.menu.id = `custom-dropdown-menu-${++_menuSeq}`;
        this.trigger.setAttribute('aria-controls', this.menu.id);

        this.select.style.display = 'none';
        this.select.parentNode!.insertBefore(this.wrapper, this.select);
        this.wrapper.appendChild(this.trigger);
        this.wrapper.appendChild(this.menu);
        this.wrapper.appendChild(this.select);
    }

    _bindEvents(): void {
        this.trigger.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            if (this.select.disabled) return;
            this.toggle();
        });

        this.menu.addEventListener('click', (e: MouseEvent) => {
            const item = (e.target as HTMLElement).closest('.custom-dropdown-item') as HTMLElement | null;
            if (!item) return;
            const value = item.dataset.value;
            if (value !== undefined) {
                this._selectValue(value);
            }
            this.close();
        });

        this._onKeyDown = this._onKeyDown.bind(this);
        this.menu.addEventListener('keydown', this._onKeyDown);

        // The trigger is a button, so Enter/Space already open it through the
        // click handler; arrow keys are what a listbox trigger is expected to
        // answer to as well.
        this.trigger.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            if (this.select.disabled) return;
            this.open(e.key === 'ArrowUp');
        });

        this._onDocumentClick = (e: MouseEvent) => {
            if (!this.wrapper.contains(e.target as Node)) {
                this.close();
            }
        };
    }

    _onKeyDown(e: KeyboardEvent): void {
        const items = [...this.menu.querySelectorAll<HTMLElement>('.custom-dropdown-item')];
        const currentIndex = items.indexOf(document.activeElement as HTMLElement);

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (currentIndex + 1 < items.length) items[currentIndex + 1].focus();
                else items[0]?.focus();
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (currentIndex - 1 >= 0) items[currentIndex - 1].focus();
                else items[items.length - 1]?.focus();
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                if (document.activeElement?.classList.contains('custom-dropdown-item')) {
                    this._selectValue((document.activeElement as HTMLElement).dataset.value!);
                    this.close();
                }
                break;
            case 'Tab':
                this.trigger.focus();
                this.close();
                break;
            case 'Escape':
                e.preventDefault();
                this.close();
                this.trigger.focus();
                break;
            case 'Home':
                e.preventDefault();
                items[0]?.focus();
                break;
            case 'End':
                e.preventDefault();
                items[items.length - 1]?.focus();
                break;
        }
    }

    _selectValue(value: string): void {
        this.select.value = value;
        this.select.dispatchEvent(new Event('change', { bubbles: true }));
        this._updateTriggerText();
    }

    _updateTriggerText(): void {
        const selectedOpt = this.select.options[this.select.selectedIndex];
        this.trigger.textContent = selectedOpt ? selectedOpt.textContent : '';
        this._appendArrow();
    }

    _appendArrow(): void {
        const arrow = document.createElement('span');
        arrow.className = 'custom-dropdown-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        this.trigger.appendChild(arrow);
    }

    _updateDisabled(): void {
        if (this.select.disabled) {
            this.wrapper.classList.add('disabled');
            this.trigger.tabIndex = -1;
        } else {
            this.wrapper.classList.remove('disabled');
            this.trigger.tabIndex = 0;
        }
    }

    sync(): void {
        this.menu.innerHTML = '';
        const options = [...this.select.options];
        if (options.length === 0) {
            this.trigger.textContent = '';
            this._appendArrow();
            this._updateDisabled();
            return;
        }

        for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const item = document.createElement('div');
            item.className = 'custom-dropdown-item';
            item.setAttribute('role', 'option');
            // Focused with .focus() from the keyboard handler, never tabbed to:
            // the listbox is one stop in the tab order, its trigger.
            item.tabIndex = -1;
            item.dataset.value = opt.value;
            item.textContent = opt.textContent;
            item.setAttribute('aria-selected', String(opt.selected || i === this.select.selectedIndex));
            if (opt.selected || i === this.select.selectedIndex) {
                item.classList.add('selected');
            }
            if (opt.disabled) {
                item.classList.add('disabled');
                item.setAttribute('aria-disabled', 'true');
            }
            this.menu.appendChild(item);
        }

        this._updateTriggerText();
        this._updateDisabled();
    }

    open(focusLast = false): void {
        if (this.select.disabled || this.select.options.length === 0) return;
        if (this.menu.classList.contains('open')) return;

        this.menu.classList.add('open');
        this.wrapper.classList.add('open');
        this.trigger.setAttribute('aria-expanded', 'true');

        const rect = this.wrapper.getBoundingClientRect();
        const menuHeight = this.menu.offsetHeight;
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        this.menu.style.position = 'fixed';
        this.menu.style.left = rect.left + 'px';
        this.menu.style.minWidth = rect.width + 'px';

        if (spaceBelow < menuHeight && spaceAbove > menuHeight) {
            this.menu.classList.add('flip-up');
            this.menu.style.top = 'auto';
            this.menu.style.bottom = window.innerHeight - rect.top + 'px';
        } else {
            this.menu.classList.remove('flip-up');
            this.menu.style.top = rect.bottom + 'px';
            this.menu.style.bottom = 'auto';
        }

        const items = this.menu.querySelectorAll<HTMLElement>('.custom-dropdown-item');
        const target = focusLast ? items[items.length - 1] : items[0];
        if (target) target.focus();

        document.addEventListener('click', this._onDocumentClick);
    }

    close(): void {
        if (!this.menu.classList.contains('open')) return;
        this.menu.classList.remove('open');
        this.wrapper.classList.remove('open');
        this.trigger.setAttribute('aria-expanded', 'false');
        this.menu.style.position = '';
        this.menu.style.left = '';
        this.menu.style.top = '';
        this.menu.style.bottom = '';
        this.menu.style.minWidth = '';
        document.removeEventListener('click', this._onDocumentClick);
    }

    toggle(): void {
        if (this.menu.classList.contains('open')) {
            this.close();
        } else {
            this.open();
        }
    }

    destroy(): void {
        this._observer.disconnect();
        document.removeEventListener('click', this._onDocumentClick);
        this.select.style.display = '';
        this.wrapper.replaceWith(this.select);
    }
}
