import fs from "fs";
import path from "path";
import { BrowserWindow, session } from "electron";
import { FileSystem } from "@server/fileSystem";
import { Window } from ".";

export type GoogleFindOAuthMode = "auth" | "vault";

export interface GoogleFindOAuthWindowOptions {
    mode: GoogleFindOAuthMode;
    kdi?: string;
    email?: string | null;
    onOAuthToken?: (
        oauthToken: string
    ) => Promise<{ kdi?: string; email?: string | null } | void> | { kdi?: string; email?: string | null } | void;
    onVaultKeys?: (payload: { str?: unknown; vaultKeys?: unknown }) => Promise<void> | void;
    onError?: (err: Error) => void;
}

export const GFIND_OAUTH_PARTITION = "persist:gfind-oauth";

export const buildGoogleVaultUnlockUrl = (kdi?: string, emailHint?: string | null): string => {
    const unlockUrl = kdi
        ? `https://accounts.google.com/encryption/unlock/android?kdi=${encodeURIComponent(kdi)}`
        : "https://accounts.google.com/encryption/unlock/android";
    // /encryption/unlock/android returns 401 Malformed without an active web Gaia session; route via ServiceLogin.
    const params = new URLSearchParams({ continue: unlockUrl });
    if (emailHint && emailHint.trim()) {
        params.set("Email", emailHint.trim());
    }
    return `https://accounts.google.com/ServiceLogin?${params.toString()}`;
};

export const stripElectronUserAgent = (ua: string): string =>
    ua.replace(/\s*Electron\/[^\s]+/gi, "").replace(/\s*BlueBubbles\/[^\s]+/gi, "").trim();

const resolveVaultPreloadPath = (): string => {
    const candidates = [
        path.join(__dirname, "gfindVaultPreload.js"),
        path.join(FileSystem.resources, "gfindVaultPreload.js"),
        path.resolve(__dirname, "../appResources/gfindVaultPreload.js"),
        path.resolve(process.cwd(), "appResources/gfindVaultPreload.js")
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`Missing gfindVaultPreload.js (checked: ${candidates.join(", ")})`);
};

export class GoogleFindOAuthWindow extends Window {
    private static self: GoogleFindOAuthWindow | null = null;
    private options: GoogleFindOAuthWindowOptions;
    private authHandled = false;
    private vaultHandled = false;

    private constructor(options: GoogleFindOAuthWindowOptions) {
        super();
        this.options = options;
    }

    public static open(options: GoogleFindOAuthWindowOptions): GoogleFindOAuthWindow {
        if (GoogleFindOAuthWindow.self?.instance && !GoogleFindOAuthWindow.self.instance.isDestroyed()) {
            GoogleFindOAuthWindow.self.instance.destroy();
        }
        GoogleFindOAuthWindow.self = new GoogleFindOAuthWindow(options);
        return GoogleFindOAuthWindow.self.build();
    }

    public static async clearSession(): Promise<void> {
        await session.fromPartition(GFIND_OAUTH_PARTITION).clearStorageData();
    }

    private loadVaultUrl(kdi?: string, userAgent?: string, emailHint?: string | null): void {
        if (!this.instance || this.instance.isDestroyed()) return;
        const targetUrl = buildGoogleVaultUnlockUrl(kdi, emailHint ?? this.options.email);
        this.instance.loadURL(targetUrl, userAgent ? { userAgent } : undefined).catch(err => {
            if (err?.code !== "ERR_ABORTED") {
                this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    build(): GoogleFindOAuthWindow {
        const ses = session.fromPartition(GFIND_OAUTH_PARTITION);
        const preloadPath = resolveVaultPreloadPath();
        const chromeUa = stripElectronUserAgent(ses.getUserAgent());

        this.instance = new BrowserWindow({
            width: 540,
            height: 740,
            title: this.options.mode === "vault" ? "Google Find Hub E2EE Unlock" : "Google Find Hub Sign-In",
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: preloadPath,
                session: ses
            }
        });
        if (chromeUa) {
            this.instance.webContents.setUserAgent(chromeUa);
        }

        const handleVaultKeys = async (payload: { str?: unknown; vaultKeys?: unknown }) => {
            const currentUrl = this.instance?.webContents.getURL() ?? "";
            if (!currentUrl.startsWith("https://accounts.google.com/")) {
                throw new Error("Unauthorized origin for vault key submission");
            }
            if (this.vaultHandled) return;
            this.vaultHandled = true;
            try {
                await this.options.onVaultKeys?.(payload ?? {});
            } catch (err: any) {
                this.vaultHandled = false;
                this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
                throw err;
            }
        };

        const handleVaultClose = async () => {
            const currentUrl = this.instance?.webContents.getURL() ?? "";
            if (!currentUrl.startsWith("https://accounts.google.com/")) {
                throw new Error("Unauthorized origin for closing vault window");
            }
            if (this.instance && !this.instance.isDestroyed()) {
                this.instance.close();
            }
        };

        // Scope vault IPC strictly to this window's webContents and verify Google origin.
        this.instance.webContents.ipc.handle("gfind-vault-keys", (_event, payload) => handleVaultKeys(payload));
        this.instance.webContents.ipc.handle("gfind-vault-close", () => handleVaultClose());
        this.instance.webContents.ipc.on("gfind-vault-keys", (_event, payload) => {
            void handleVaultKeys(payload).catch(() => undefined);
        });
        this.instance.webContents.ipc.on("gfind-vault-close", () => {
            void handleVaultClose().catch(() => undefined);
        });

        const isGoogleDomain = (domain?: string): boolean =>
            domain === "google.com" || domain === ".google.com" || Boolean(domain?.endsWith(".google.com"));

        const cookieListener = (_event: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
            if (
                this.authHandled ||
                removed ||
                cookie.name !== "oauth_token" ||
                !cookie.value ||
                !isGoogleDomain(cookie.domain)
            ) {
                return;
            }
            this.authHandled = true;
            Promise.resolve(this.options.onOAuthToken?.(cookie.value))
                .then(res => {
                    const cookieHost = (cookie.domain || "accounts.google.com").replace(/^\./, "");
                    const cookieUrl = `https://${cookieHost}${cookie.path || "/"}`;
                    void Promise.resolve(ses.cookies.remove?.(cookieUrl, cookie.name)).catch(() => undefined);
                    if (res && typeof res === "object" && "kdi" in res && res.kdi) {
                        this.loadVaultUrl(res.kdi, chromeUa, res.email);
                    } else {
                        this.loadVaultUrl(this.options.kdi, chromeUa, res && typeof res === "object" ? res.email : undefined);
                    }
                })
                .catch(err => {
                    this.authHandled = false;
                    this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
                });
        };

        if (this.options.mode === "auth") {
            ses.cookies.on("changed", cookieListener);
        }

        this.instance.on("closed", () => {
            if (this.options.mode === "auth") {
                ses.cookies.removeListener("changed", cookieListener);
            }
            this.instance = null;
        });

        if (this.options.mode === "vault") {
            this.loadVaultUrl(this.options.kdi, chromeUa);
        } else {
            this.instance
                .loadURL("https://accounts.google.com/EmbeddedSetup", chromeUa ? { userAgent: chromeUa } : undefined)
                .catch(err => {
                    if (err?.code !== "ERR_ABORTED") {
                        this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
                    }
                });
        }

        return this;
    }
}
