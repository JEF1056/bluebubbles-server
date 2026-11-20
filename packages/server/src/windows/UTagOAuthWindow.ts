import { BrowserWindow, session } from "electron";
import { Window } from ".";

export interface UTagOAuthWindowOptions {
    url: string;
    onCallbackUrl: (callbackUrl: string) => Promise<void> | void;
    onError?: (err: Error) => void;
}

export class UTagOAuthWindow extends Window {
    private static self: UTagOAuthWindow | null = null;
    private options: UTagOAuthWindowOptions;
    private handled = false;

    private constructor(options: UTagOAuthWindowOptions) {
        super();
        this.options = options;
    }

    public static open(options: UTagOAuthWindowOptions): UTagOAuthWindow {
        if (UTagOAuthWindow.self?.instance && !UTagOAuthWindow.self.instance.isDestroyed()) {
            UTagOAuthWindow.self.instance.destroy();
        }
        UTagOAuthWindow.self = new UTagOAuthWindow(options);
        return UTagOAuthWindow.self.build();
    }

    private handleInterceptedUrl(url: string): void {
        if (this.handled || !url.startsWith("ms-app://")) return;
        this.handled = true;

        Promise.resolve(this.options.onCallbackUrl(url))
            .catch(err => {
                this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
            })
            .finally(() => {
                if (this.instance && !this.instance.isDestroyed()) {
                    this.instance.close();
                }
                this.instance = null;
            });
    }

    build(): UTagOAuthWindow {
        const ses = session.fromPartition("utag-oauth");
        this.instance = new BrowserWindow({
            width: 520,
            height: 720,
            title: "Samsung SmartThings Find Sign-In",
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                session: ses
            }
        });

        const cleanupProtocol = () => {
            try {
                ses.protocol.unhandle("ms-app");
            } catch {
                // Ignore if handler was not registered
            }
        };

        // Electron's webRequest rejects custom schemes (ms-app://); intercept via protocol + navigation hooks instead.
        cleanupProtocol();
        ses.protocol.handle("ms-app", request => {
            this.handleInterceptedUrl(request.url);
            return new Response("<html><body>Samsung SmartThings Find sign-in complete.</body></html>", {
                status: 200,
                headers: { "content-type": "text/html; charset=utf-8" }
            });
        });

        this.instance.webContents.on("will-redirect", (event, url) => {
            if (url.startsWith("ms-app://")) {
                event.preventDefault();
                this.handleInterceptedUrl(url);
            }
        });

        this.instance.webContents.on("will-navigate", (event, url) => {
            if (url.startsWith("ms-app://")) {
                event.preventDefault();
                this.handleInterceptedUrl(url);
            }
        });

        this.instance.webContents.setWindowOpenHandler(({ url }) => {
            if (url.startsWith("ms-app://")) {
                this.handleInterceptedUrl(url);
                return { action: "deny" };
            }
            return { action: "allow" };
        });

        this.instance.webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, validatedURL) => {
            if (validatedURL?.startsWith("ms-app://")) {
                this.handleInterceptedUrl(validatedURL);
            }
        });

        const chromeUserAgent =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

        this.instance.on("closed", () => {
            if (UTagOAuthWindow.self === this) {
                cleanupProtocol();
            }
            this.instance = null;
        });

        this.instance.loadURL(this.options.url, { userAgent: chromeUserAgent }).catch(err => {
            if (err?.code !== "ERR_ABORTED" && !this.handled) {
                this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        });
        return this;
    }
}
