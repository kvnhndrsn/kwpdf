// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { CustomDropdown } from '../dropdown';

function setup(values = ['a', 'b', 'c'], selected = 0) {
    document.body.innerHTML = '<select id="pick"></select>';
    const select = document.getElementById('pick');
    values.forEach((value, i) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = 'Option ' + value;
        option.selected = i === selected;
        select.appendChild(option);
    });
    return { select, dropdown: new CustomDropdown(select) };
}

const trigger = () => document.querySelector('.custom-dropdown-trigger');
const menu = () => document.querySelector('.custom-dropdown-menu');
const items = () => [...document.querySelectorAll('.custom-dropdown-item')];

const key = (el, keyName) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }));

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('CustomDropdown keyboard access', () => {
    it('wires the trigger to its listbox', () => {
        setup();

        expect(menu().getAttribute('role')).toBe('listbox');
        expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(trigger().getAttribute('aria-controls')).toBe(menu().id);
        expect(menu().id).toBeTruthy();
    });

    it('keeps options out of the tab order but focusable', () => {
        setup();

        expect(items()).toHaveLength(3);
        for (const item of items()) {
            expect(item.getAttribute('role')).toBe('option');
            expect(item.tabIndex).toBe(-1);
        }
        expect(items()[0].getAttribute('aria-selected')).toBe('true');
        expect(items()[1].getAttribute('aria-selected')).toBe('false');
        expect(items()[2].getAttribute('aria-selected')).toBe('false');
    });

    it('opens from the trigger with the arrow keys', () => {
        setup();
        trigger().focus();

        key(trigger(), 'ArrowDown');

        expect(menu().classList.contains('open')).toBe(true);
        expect(trigger().getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(items()[0]);
    });

    it('opens on the last option with ArrowUp', () => {
        setup();
        trigger().focus();

        key(trigger(), 'ArrowUp');

        expect(document.activeElement).toBe(items()[2]);
    });

    it('moves through the options with the arrows and wraps', () => {
        setup();
        key(trigger(), 'ArrowDown');
        expect(document.activeElement).toBe(items()[0]);

        key(items()[0], 'ArrowDown');
        expect(document.activeElement).toBe(items()[1]);

        items()[2].focus();
        key(items()[2], 'ArrowDown');
        expect(document.activeElement).toBe(items()[0]);

        items()[0].focus();
        key(items()[0], 'ArrowUp');
        expect(document.activeElement).toBe(items()[2]);
    });

    it('selects the focused option with Enter and closes', () => {
        const { select } = setup();
        const changes = [];
        select.addEventListener('change', () => changes.push(select.value));

        key(trigger(), 'ArrowDown');
        items()[1].focus();
        key(items()[1], 'Enter');

        expect(select.value).toBe('b');
        expect(changes).toEqual(['b']);
        expect(trigger().textContent).toContain('Option b');
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(menu().classList.contains('open')).toBe(false);
    });

    it('selects with Space as well', () => {
        const { select } = setup();

        key(trigger(), 'ArrowDown');
        items()[2].focus();
        key(items()[2], ' ');

        expect(select.value).toBe('c');
    });

    it('closes on Escape and returns focus to the trigger', () => {
        setup();
        key(trigger(), 'ArrowDown');
        items()[1].focus();

        key(items()[1], 'Escape');

        expect(menu().classList.contains('open')).toBe(false);
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger());
    });
});
