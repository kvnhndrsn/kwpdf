// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const MARKUP = `
<div id="passwordDialog">
    <div class="modal">
        <p id="passwordFileName"></p>
        <input type="password" id="passwordInput">
        <p id="passwordError" style="display:none;"></p>
        <button id="passwordOpenBtn">Open</button>
        <button id="passwordCancelBtn">Cancel</button>
    </div>
</div>`;

const $ = (id) => document.getElementById(id);

async function load() {
    vi.resetModules();
    document.body.innerHTML = MARKUP;
    // The module resolves everything through getElementById, so a fresh body is
    // enough to get a fresh dialog; the module itself is reset for its listeners.
    return import('../password-prompt');
}

const dialog = () => $('passwordDialog');

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('requestPassword', () => {
    it('opens the dialog and resolves with the typed password', async () => {
        const { requestPassword } = await load();

        const answer = requestPassword('locked.pdf');
        expect(dialog().classList.contains('show')).toBe(true);
        expect($('passwordFileName').textContent).toBe('locked.pdf');

        $('passwordInput').value = 'hunter2';
        $('passwordOpenBtn').click();

        await expect(answer).resolves.toBe('hunter2');
        expect(dialog().classList.contains('show')).toBe(false);
    });

    it('submits on Enter and ignores an empty password', async () => {
        const { requestPassword } = await load();
        const answer = requestPassword('locked.pdf');

        $('passwordInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(dialog().classList.contains('show')).toBe(true);

        $('passwordInput').value = 'secret';
        $('passwordInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        await expect(answer).resolves.toBe('secret');
    });

    it('resolves null when cancelled', async () => {
        const { requestPassword } = await load();
        const answer = requestPassword('locked.pdf');

        $('passwordCancelBtn').click();

        await expect(answer).resolves.toBeNull();
        expect(dialog().classList.contains('show')).toBe(false);
    });

    it('reports a wrong password on the retry and clears it otherwise', async () => {
        const { requestPassword } = await load();

        const first = requestPassword('locked.pdf', true);
        expect($('passwordError').textContent).toMatch(/Incorrect password/);
        expect($('passwordError').style.display).toBe('');
        $('passwordCancelBtn').click();
        await first;

        const second = requestPassword('other.pdf', false);
        expect($('passwordError').textContent).toBe('');
        expect($('passwordError').style.display).toBe('none');
        $('passwordCancelBtn').click();
        await second;
    });

    it('abandons an unanswered prompt when the next document asks', async () => {
        const { requestPassword } = await load();

        const first = requestPassword('first.pdf');
        const second = requestPassword('second.pdf');

        await expect(first).resolves.toBeNull();
        expect($('passwordFileName').textContent).toBe('second.pdf');

        $('passwordCancelBtn').click();
        await expect(second).resolves.toBeNull();
    });
});
