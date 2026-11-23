import { generateUuid } from "@server/helpers/utils";

export type TransactionId = string;

export enum TransactionType {
    CHAT,
    MESSAGE,
    ATTACHMENT,
    HANDLE,
    FIND_MY,
    OTHER
}

export type TransactionResult = {
    type: TransactionType;
    identifier: string;
    data?: any;
};

export class TransactionPromise {
    promise: Promise<TransactionResult>;

    private resolvePromise: (value: any) => void;

    private rejectPromise: (reason?: any) => void;

    transactionId: string;

    type: TransactionType;

    isResolved = false;

    errored = false;

    error: any;

    private timeout: NodeJS.Timeout | null = null;

    private onSettled: (() => void) | null = null;

    constructor(type: TransactionType) {
        // Create a promise and save the "callbacks"
        this.promise = new Promise((resolve, reject) => {
            this.resolvePromise = resolve;
            this.rejectPromise = reject;
        });

        // Hook into the resolve and rejects so we can set flags based on the status
        this.promise.catch((err: any) => {
            this.errored = true;
            this.error = err;
        });

        this.transactionId = generateUuid();
        this.type = type;

        // Create a timeout for how long until we "error-out".
        // 2 minute timeout for transactions
        this.timeout = setTimeout(() => {
            this.timeout = null;
            if (this.isResolved) return;

            // This will trigger our hook handlers, created in the constructor
            this.reject("Transaction timeout");
        }, 30000 * 2 * 2);
        this.timeout.unref?.();
    }

    setOnSettled(callback: () => void) {
        if (this.isResolved) {
            callback();
            return;
        }
        this.onSettled = callback;
    }

    private clearPendingTimeout() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }

    resolve(value: TransactionId, data?: any) {
        if (this.isResolved) return;
        this.isResolved = true;
        this.clearPendingTimeout();
        const output: TransactionResult = {
            type: this.type,
            identifier: value
        };

        // Add additional data if needed
        if (data) output.data = data;

        // Resolve the promise
        this.resolvePromise(output as TransactionResult);
        this.onSettled?.();
        this.onSettled = null;
    }

    reject(reason?: any) {
        if (this.isResolved) return;
        this.isResolved = true;
        this.clearPendingTimeout();
        this.rejectPromise(reason);
        this.onSettled?.();
        this.onSettled = null;
    }

    isSame(transactionId: string) {
        return this.transactionId === transactionId;
    }
}
