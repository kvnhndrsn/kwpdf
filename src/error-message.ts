/** A caught value need not be an Error — template strings are fine too. */
export function errorMessage(err: any): string {
    return err && err.message ? String(err.message) : String(err);
}
