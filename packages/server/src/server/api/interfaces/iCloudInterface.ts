import { Server } from "@server";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { bytesToBase64 } from "byte-base64";
import { isMinBigSur, isMinHighSierra } from "@server/env";
import { checkPrivateApiStatus, isNotEmpty } from "@server/helpers/utils";
import { ContactInterface } from "./contactInterface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

const execFileAsync = promisify(execFile);

type ProfileCandidate = {
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    appleId?: string | null;
    avatar?: string | null;
};

const cleanString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().replace(/\s+/g, " ");
    return trimmed.length > 0 ? trimmed : null;
};

const splitDisplayName = (fullName: string | null): { firstName: string | null; lastName: string | null } => {
    const cleaned = cleanString(fullName);
    if (!cleaned) return { firstName: null, lastName: null };
    const [firstName, ...rest] = cleaned.split(" ");
    return { firstName, lastName: rest.length ? rest.join(" ") : null };
};

const joinName = (firstName: string | null, lastName: string | null): string | null =>
    [firstName, lastName].filter(Boolean).join(" ") || null;

const extractImageBase64 = async (rawBytes: Buffer | null | undefined, sourcePath?: string): Promise<string | null> => {
    if (!rawBytes || rawBytes.length < 4) return null;

    // Strip Apple AddressBook's 1-byte (0x01 / 0x02) image type prefix if JPEG/PNG follows at offset 1
    let buf = rawBytes;
    const hasHeader = (b: Buffer, o: number) =>
        (b[o] === 0xff && b[o + 1] === 0xd8 && b[o + 2] === 0xff) ||
        (b[o] === 0x89 && b[o + 1] === 0x50 && b[o + 2] === 0x4e && b[o + 3] === 0x47);
    if (buf.length > 5 && (buf[0] === 0x01 || buf[0] === 0x02) && hasHeader(buf, 1)) {
        buf = buf.subarray(1);
    }

    if (hasHeader(buf, 0)) {
        return bytesToBase64(buf);
    }

    // Convert macOS HEIC/TIFF user pictures into PNG for cross-platform Flutter/web Image.memory compatibility
    let inputPath = sourcePath && fs.existsSync(sourcePath) ? sourcePath : null;
    let tmpIn: string | null = null;
    const tmpOut = path.join(os.tmpdir(), `bb-avatar-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    try {
        if (!inputPath) {
            tmpIn = path.join(os.tmpdir(), `bb-avatar-in-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            fs.writeFileSync(tmpIn, buf);
            inputPath = tmpIn;
        }
        await execFileAsync("/usr/bin/sips", ["-s", "format", "png", inputPath, "--out", tmpOut], { timeout: 4000 });
        if (fs.existsSync(tmpOut)) {
            const converted = fs.readFileSync(tmpOut);
            if (converted.length > 0 && hasHeader(converted, 0)) return bytesToBase64(converted);
        }
    } catch {
        // Ignore sips conversion failure
    } finally {
        if (tmpIn) {
            try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
        }
        try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    }

    return null;
};

const normalizePhoneTail = (value: string): string => {
    const digits = value.replace(/\D/g, "");
    return digits.length >= 7 ? digits.slice(-10) : digits;
};

const readMobileMeAccount = async (): Promise<ProfileCandidate> => {
    const plistPath = path.join(os.homedir(), "Library/Preferences/MobileMeAccounts.plist");
    if (!fs.existsSync(plistPath)) return {};

    try {
        const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
            timeout: 3000,
            maxBuffer: 1024 * 1024
        });
        const parsed = JSON.parse(stdout);
        const accounts = Array.isArray(parsed?.Accounts) ? parsed.Accounts : [];
        const primary =
            accounts.find((acc: any) => cleanString(acc?.AccountID) != null && acc?.LoggedIn !== false) ?? accounts[0];
        if (!primary) return {};

        const firstName = cleanString(primary.FirstName);
        const lastName = cleanString(primary.LastName);
        return {
            appleId: cleanString(primary.AccountID),
            name: cleanString(primary.DisplayName) ?? joinName(firstName, lastName),
            firstName,
            lastName
        };
    } catch {
        return {};
    }
};

const readDsclAttr = async (username: string, attr: string, maxBuffer?: number): Promise<string | null> => {
    try {
        const { stdout } = await execFileAsync("/usr/bin/dscl", [".", "-read", `/Users/${username}`, attr], {
            timeout: maxBuffer ? 3000 : 2000,
            ...(maxBuffer ? { maxBuffer } : {})
        });
        return stdout.replace(new RegExp(`^${attr}:\\s*`, "m"), "");
    } catch {
        return null;
    }
};

const readSystemUserProfile = async (loadAvatar: boolean): Promise<ProfileCandidate> => {
    const username = os.userInfo().username;
    const realName = cleanString(await readDsclAttr(username, "RealName")) ?? cleanString(username);
    let avatar: string | null = null;

    if (loadAvatar) {
        const hex = (await readDsclAttr(username, "JPEGPhoto", 4 * 1024 * 1024))?.replace(/\s+/g, "");
        if (hex && /^[0-9a-fA-F]+$/.test(hex) && hex.length >= 16) {
            avatar = await extractImageBase64(Buffer.from(hex, "hex"));
        }

        if (!avatar) {
            const picPath = cleanString(await readDsclAttr(username, "Picture"));
            if (picPath && fs.existsSync(picPath)) {
                avatar = await extractImageBase64(fs.readFileSync(picPath), picPath);
            }
        }
    }

    return { name: realName, ...splitDisplayName(realName), avatar };
};

const listAddressBookDbs = (): string[] => {
    const baseDir = path.join(os.homedir(), "Library/Application Support/AddressBook");
    const results: string[] = [];
    const rootDb = path.join(baseDir, "AddressBook-v22.abcddb");
    if (fs.existsSync(rootDb)) results.push(rootDb);

    const sourcesDir = path.join(baseDir, "Sources");
    if (fs.existsSync(sourcesDir)) {
        try {
            for (const entry of fs.readdirSync(sourcesDir)) {
                const candidate = path.join(sourcesDir, entry, "AddressBook-v22.abcddb");
                if (fs.existsSync(candidate)) results.push(candidate);
            }
        } catch {
            // Ignore unreadable Sources dir
        }
    }
    return results;
};

const readAddressBookProfile = async (
    identifiers: string[],
    isSelf: boolean,
    loadAvatar: boolean
): Promise<ProfileCandidate> => {
    let best: ProfileCandidate = {};
    const mergeCandidate = (c: ProfileCandidate): boolean => {
        best = {
            name: best.name ?? c.name,
            firstName: best.firstName ?? c.firstName,
            lastName: best.lastName ?? c.lastName,
            avatar: best.avatar ?? c.avatar
        };
        return Boolean(best.name && (!loadAvatar || best.avatar));
    };

    // First try BlueBubbles' ContactInterface (cached DB + node-mac-contacts)
    try {
        if (identifiers.length > 0) {
            for (const c of await ContactInterface.queryContacts(identifiers)) {
                const firstName = cleanString(c?.firstName);
                const lastName = cleanString(c?.lastName);
                const name = cleanString(c?.displayName) ?? joinName(firstName, lastName);
                const avatar = loadAvatar ? cleanString(c?.avatar) : null;
                if ((name || avatar) && mergeCandidate({ name, firstName, lastName, avatar })) return best;
            }
        }
    } catch {
        // Fall back to direct AddressBook SQLite inspection
    }

    const emailSet = new Set(
        identifiers.filter(id => id.includes("@")).map(id => id.trim().toLowerCase())
    );
    const phoneTails = new Set(
        identifiers
            .filter(id => !id.includes("@"))
            .map(normalizePhoneTail)
            .filter(tail => tail.length >= 7)
    );

    for (const dbPath of listAddressBookDbs()) {
        let db: any = null;
        try {
            db = new Database(dbPath, { readonly: true, fileMustExist: true });
            const existingCols = new Set(
                (db.prepare("PRAGMA table_info(ZABCDRECORD)").all() as Array<{ name: string }>).map(c => c.name)
            );
            const wantedCols = ["ZFIRSTNAME", "ZLASTNAME", "ZNICKNAME", "ZORGANIZATION"];
            if (loadAvatar) {
                for (const imgCol of ["ZIMAGEDATA", "ZTHUMBNAILIMAGEDATA", "ZTHUMBNAILDATA"]) {
                    if (existingCols.has(imgCol)) wantedCols.push(imgCol);
                }
            }
            const selectCols = wantedCols.filter(c => existingCols.has(c)).map(c => `r.${c}`).join(", ");
            if (!selectCols) continue;

            const rows: any[] = [];
            if (isSelf && existingCols.has("ZME")) {
                try {
                    rows.push(...db.prepare(`SELECT ${selectCols} FROM ZABCDRECORD r WHERE r.ZME = 1 LIMIT 3`).all());
                } catch {
                    // Ignore ZME query errors
                }
            }

            const queries: Array<[Set<string>, string, string, (v: string) => string]> = [
                [emailSet, "ZABCDEMAILADDRESS", "ZADDRESSNORMALIZED", v => v.trim().toLowerCase()],
                [phoneTails, "ZABCDPHONENUMBER", "ZFULLNUMBER", normalizePhoneTail]
            ];
            for (const [targets, table, col, norm] of queries) {
                if (targets.size === 0) continue;
                const matched = db
                    .prepare(`SELECT ${selectCols}, t.${col} AS match_val FROM ZABCDRECORD r JOIN ${table} t ON t.ZOWNER = r.Z_PK WHERE t.${col} IS NOT NULL`)
                    .all() as any[];
                for (const row of matched) {
                    if (targets.has(norm(String(row.match_val)))) rows.push(row);
                }
            }

            for (const row of rows) {
                const firstName = cleanString(row.ZFIRSTNAME);
                const lastName = cleanString(row.ZLASTNAME);
                const name = joinName(firstName, lastName) ?? cleanString(row.ZNICKNAME) ?? cleanString(row.ZORGANIZATION);
                let avatar: string | null = null;
                if (loadAvatar && !best.avatar) {
                    const imgBuf = Buffer.isBuffer(row.ZIMAGEDATA)
                        ? row.ZIMAGEDATA
                        : Buffer.isBuffer(row.ZTHUMBNAILIMAGEDATA)
                          ? row.ZTHUMBNAILIMAGEDATA
                          : Buffer.isBuffer(row.ZTHUMBNAILDATA)
                            ? row.ZTHUMBNAILDATA
                            : null;
                    avatar = await extractImageBase64(imgBuf);
                }
                if (mergeCandidate({ name, firstName, lastName, avatar })) return best;
            }
        } catch {
            // Ignore locked or unreadable AddressBook DB
        } finally {
            try {
                db?.close();
            } catch {
                // Ignore close failure
            }
        }
    }

    return best;
};

const readNickNameCacheAvatar = async (identifiers: string[], isSelf: boolean): Promise<string | null> => {
    const cacheDir = path.join(os.homedir(), "Library/Messages/NickNameCache");
    if (!fs.existsSync(cacheDir)) return null;

    // Look for decoded image files if present (matching self/handle keys when non-self)
    try {
        const entries = fs
            .readdirSync(cacheDir)
            .filter(name => !name.includes(".db") && !name.startsWith("."))
            .map(name => path.join(cacheDir, name));

        const normalizedIds = identifiers.map(id => id.toLowerCase());
        const matchingFiles = entries.filter(filePath => {
            const base = path.basename(filePath).toLowerCase();
            return (isSelf && base.includes("self")) || normalizedIds.some(id => id.length >= 4 && base.includes(id));
        });

        for (const filePath of matchingFiles) {
            try {
                const stat = fs.statSync(filePath);
                if (!stat.isFile() || stat.size < 32 || stat.size > 10 * 1024 * 1024) continue;
                const avatar = await extractImageBase64(fs.readFileSync(filePath), filePath);
                if (avatar) return avatar;
            } catch {
                // Ignore unreadable cache file
            }
        }
    } catch {
        // Ignore NickNameCache read errors
    }

    return null;
};

const extractActiveAliases = (accountData: Record<string, any> | null | undefined): string[] => {
    const collected: string[] = [];
    const pushUnique = (val: unknown) => {
        const cleaned = cleanString(val);
        if (cleaned && !collected.includes(cleaned)) collected.push(cleaned);
    };

    pushUnique(accountData?.active_alias);
    for (const listKey of ["aliases", "vetted_aliases"] as const) {
        const list = accountData?.[listKey];
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (typeof entry === "string") {
                pushUnique(entry);
            } else if (entry && typeof entry === "object" && entry.IsUserVisible !== false) {
                pushUnique(entry.Alias);
            }
        }
    }
    pushUnique(accountData?.apple_id);
    return collected;
};

const matchesSelfIdentifier = (address: string, selfIdentifiers: string[]): boolean => {
    const normalized = address.trim().toLowerCase();
    if (!normalized) return false;
    const isEmail = normalized.includes("@");
    const phoneTail = isEmail ? "" : normalizePhoneTail(normalized);
    return selfIdentifiers.some(id => {
        const candidate = id.trim().toLowerCase();
        if (!candidate) return false;
        if (candidate === normalized) return true;
        if (!isEmail && !candidate.includes("@") && phoneTail.length >= 7) {
            return normalizePhoneTail(candidate) === phoneTail;
        }
        return false;
    });
};

export class iCloudInterface {
    private static readonly ACCOUNT_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
    private static accountInfoCache: {
        data: Record<string, any>;
        includeAvatar: boolean;
        expiresAt: number;
    } | null = null;

    static invalidateAccountInfoCache(): void {
        this.accountInfoCache = null;
    }
    private static async fetchPrivateApiAccountInfo(): Promise<Record<string, any> | null> {
        try {
            if (!isMinHighSierra) return null;
            checkPrivateApiStatus();
            const res = await Server().privateApi.cloud.getAccountInfo();
            return res?.data && typeof res.data === "object" ? res.data : null;
        } catch {
            return null;
        }
    }

    private static async fetchPrivateApiContactCard(address: string | null, loadAvatar: boolean): Promise<Record<string, any> | null> {
        try {
            if (!isMinBigSur) return null;
            checkPrivateApiStatus();
            const res = await Server().privateApi.cloud.getContactCard(address);
            const card = res?.data && typeof res.data === "object" ? { ...res.data } : null;
            if (!card) return null;

            const avatarPath = card.avatar_path;
            if (isNotEmpty(avatarPath) && loadAvatar && fs.existsSync(avatarPath)) {
                const converted = await extractImageBase64(fs.readFileSync(avatarPath), avatarPath);
                if (converted) card.avatar = converted;
                delete card.avatar_path;
            }
            return card;
        } catch {
            return null;
        }
    }

    static async getAccountInfo(includeAvatar = true, prefetchedPrivateCard?: Record<string, any> | null) {
        const now = Date.now();
        if (
            this.accountInfoCache &&
            this.accountInfoCache.expiresAt > now &&
            (!includeAvatar || this.accountInfoCache.includeAvatar)
        ) {
            if (!includeAvatar && this.accountInfoCache.includeAvatar) {
                const { avatar: _omitted, ...withoutAvatar } = this.accountInfoCache.data;
                return withoutAvatar;
            }
            return { ...this.accountInfoCache.data };
        }

        const [privateAccount, mobileMe] = await Promise.all([
            this.fetchPrivateApiAccountInfo(),
            readMobileMeAccount()
        ]);

        // Preserve strict Private API error when neither Private API nor local MobileMe account is configured
        if (!privateAccount && !mobileMe.appleId) {
            checkPrivateApiStatus();
            if (!isMinHighSierra) {
                throw new Error("This API is only available on macOS Big Sur and newer!");
            }
        }

        const baseAccount: Record<string, any> = privateAccount ? { ...privateAccount } : {};
        const appleId = cleanString(baseAccount.apple_id) ?? mobileMe.appleId ?? null;
        const activeAliases = extractActiveAliases({ ...baseAccount, apple_id: appleId });
        const selfIdentifiers = Array.from(new Set([appleId, ...activeAliases].filter((v): v is string => Boolean(v))));

        let displayName = cleanString(baseAccount.account_name) ?? mobileMe.name ?? null;
        let firstName = cleanString(baseAccount.first_name) ?? mobileMe.firstName ?? null;
        let lastName = cleanString(baseAccount.last_name) ?? mobileMe.lastName ?? null;
        let avatar = cleanString(baseAccount.avatar);

        // Enrich from Private API self contact card, AddressBook Me/self record, NickNameCache, and dscl
        const privateCard =
            prefetchedPrivateCard !== undefined
                ? prefetchedPrivateCard
                : !displayName || (includeAvatar && !avatar)
                  ? await this.fetchPrivateApiContactCard(null, includeAvatar)
                  : null;
        if (privateCard) {
            displayName ??= cleanString(privateCard.name);
            avatar ??= cleanString(privateCard.avatar);
        }

        if (!displayName || !firstName || (includeAvatar && !avatar)) {
            const abProfile = await readAddressBookProfile(selfIdentifiers, true, includeAvatar && !avatar);
            displayName ??= abProfile.name ?? null;
            firstName ??= abProfile.firstName ?? null;
            lastName ??= abProfile.lastName ?? null;
            avatar ??= abProfile.avatar ?? null;
        }

        if (includeAvatar && !avatar) {
            avatar = await readNickNameCacheAvatar(selfIdentifiers, true);
        }

        if (!displayName || (includeAvatar && !avatar)) {
            const sysProfile = await readSystemUserProfile(includeAvatar && !avatar);
            if (!displayName && sysProfile.name) {
                displayName = sysProfile.name;
                firstName ??= sysProfile.firstName ?? null;
                lastName ??= sysProfile.lastName ?? null;
            }
            avatar ??= sysProfile.avatar ?? null;
        }

        if ((!firstName || !lastName) && displayName) {
            const split = splitDisplayName(displayName);
            firstName ??= split.firstName;
            lastName ??= split.lastName;
        }

        const result = {
            ...baseAccount,
            account_name: displayName,
            display_name: displayName,
            first_name: firstName,
            last_name: lastName,
            apple_id: appleId,
            active_alias: cleanString(baseAccount.active_alias) ?? activeAliases[0] ?? null,
            aliases: Array.isArray(baseAccount.aliases) ? baseAccount.aliases : [],
            vetted_aliases: Array.isArray(baseAccount.vetted_aliases) ? baseAccount.vetted_aliases : [],
            active_aliases: activeAliases,
            ...(includeAvatar ? { avatar: avatar ?? null } : {})
        };

        this.accountInfoCache = {
            data: result,
            includeAvatar,
            expiresAt: Date.now() + this.ACCOUNT_INFO_CACHE_TTL_MS
        };

        return { ...result };
    }

    private static formatContactCard(
        privateCard: Record<string, any> | null,
        loadAvatar: boolean,
        fallback?: Record<string, any>
    ) {
        const name = cleanString(privateCard?.name) ?? cleanString(fallback?.display_name);
        let firstName = cleanString(privateCard?.first_name) ?? cleanString(fallback?.first_name);
        let lastName = cleanString(privateCard?.last_name) ?? cleanString(fallback?.last_name);
        const avatar = loadAvatar ? cleanString(privateCard?.avatar) ?? cleanString(fallback?.avatar) : null;

        if (!firstName && name) {
            const split = splitDisplayName(name);
            firstName = split.firstName;
            lastName ??= split.lastName;
        }

        return {
            ...(privateCard ?? {}),
            name: name ?? null,
            display_name: name ?? null,
            first_name: firstName ?? null,
            last_name: lastName ?? null,
            avatar: avatar ?? null
        };
    }

    static async getContactCard(address: string = null, loadAvatar = true) {
        const trimmedAddress = cleanString(address);
        let isSelf = trimmedAddress == null;

        if (!isSelf && trimmedAddress != null) {
            const accountSummary = await this.getAccountInfo(false).catch(() => null);
            if (accountSummary) {
                const selfIds = [accountSummary.apple_id, ...(accountSummary.active_aliases ?? [])].filter(
                    (v): v is string => typeof v === "string" && v.length > 0
                );
                isSelf = matchesSelfIdentifier(trimmedAddress, selfIds);
            }
        }

        const privateCard = await this.fetchPrivateApiContactCard(isSelf ? null : trimmedAddress, loadAvatar);
        if (!isSelf) {
            if (!privateCard) {
                checkPrivateApiStatus();
                if (!isMinBigSur) throw new Error("This API is only available on macOS Monterey and newer!");
            }
            return this.formatContactCard(privateCard, loadAvatar);
        }

        const account = await this.getAccountInfo(loadAvatar, privateCard);
        return {
            ...this.formatContactCard(privateCard, loadAvatar, account),
            apple_id: account.apple_id ?? null,
            active_alias: account.active_alias ?? null,
            aliases: account.aliases ?? [],
            active_aliases: account.active_aliases ?? []
        };
    }

    static async modifyActiveAlias(alias: string) {
        checkPrivateApiStatus();
        const accountInfo = await this.getAccountInfo(false);
        const aliases = (accountInfo.vetted_aliases ?? []).map((e: any) => e.Alias);
        if (!aliases.includes(alias)) {
            throw new Error(`Alias, "${alias}" is not assigned/enabled for your iCloud account!`);
        }

        await Server().privateApi.cloud.modifyActiveAlias(alias);
        this.invalidateAccountInfoCache();
    }
}
