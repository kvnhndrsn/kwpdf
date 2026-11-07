/**
 * Modal password prompt for encrypted PDFs.
 *
 * pdf.js asks for a password through `onPassword` and re-asks with a different
 * reason code when the password it was given can't decrypt the document, so the
 * prompt reports a retry instead of closing itself and failing the load.
 *
 * The markup lives in index.html (#passwordDialog); everything here is resolved
 * lazily so the module can be imported before the DOM is ready.
 */

/** Resolver for the prompt the user is currently looking at. */
let pendingResolve: ((value: string | null) => void) | null = null;
let wired = false;

function elements() {
    return {
        dialog: document.getElementById('passwordDialog'),
        fileName: document.getElementById('passwordFileName'),
        input: document.getElementById('passwordInput') as HTMLInputElement | null,
        error: document.getElementById('passwordError'),
        openBtn: document.getElementById('passwordOpenBtn'),
        cancelBtn: document.getElementById('passwordCancelBtn'),
    };
}

function finish(value: string | null) {
    const resolve = pendingResolve;
    pendingResolve = null;
    elements().dialog?.classList.remove('show');
    if (resolve) resolve(value);
}

function submit() {
    const value = elements().input?.value || '';
    if (!value) return;
    finish(value);
}

function wire() {
    if (wired) return;
    wired = true;
    const { dialog, input, openBtn, cancelBtn } = elements();
    openBtn?.addEventListener('click', submit);
    cancelBtn?.addEventListener('click', () => finish(null));
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(null);
        }
    });
    // Clicking the dimmed backdrop cancels, like the other dialog.
    dialog?.addEventListener('click', (e) => {
        if (e.target === dialog) finish(null);
    });
}

/**
 * Ask for the password of `fileName`. Resolves with the typed password, or
 * null when the user cancels (which the caller treats as "don't open this").
 */
export function requestPassword(fileName: string, incorrect = false): Promise<string | null> {
    wire();
    const { dialog, fileName: nameEl, input, error } = elements();
    if (!dialog || !input) return Promise.resolve(null);

    // A newer document can ask while the previous prompt is still open; the
    // older load is abandoned rather than left waiting forever.
    finish(null);

    if (nameEl) nameEl.textContent = fileName;
    if (error) {
        error.textContent = incorrect ? 'Incorrect password, try again.' : '';
        error.style.display = incorrect ? '' : 'none';
    }
    input.value = '';
    dialog.classList.add('show');
    input.focus();

    return new Promise<string | null>((resolve) => {
        pendingResolve = resolve;
    });
}
