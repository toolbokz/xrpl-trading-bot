/**
 * Hidden passphrase prompt for TTY environments.
 */

import readline from 'readline';

/**
 * Prompt for a passphrase with hidden input (no echo).
 * @throws Error if no TTY is available
 */
export async function promptHidden(question: string): Promise<string> {
    if (!process.stdin.isTTY) {
        throw new Error(
            'Passphrase required but no TTY available. Set XRPL_SECRET_PASSPHRASE.'
        );
    }

    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        });

        // Suppress echo by overriding output
        // @ts-ignore - internal API but necessary for hidden input
        rl._writeToOutput = () => { };

        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}
