import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { Server } from "@server";
import { isMinBigSur, isMinMonterey } from "@server/env";
import { FileSystem } from "@server/fileSystem";
import { FaceTimeSessionManager } from "@server/api/lib/facetime/FacetimeSessionManager";
import { getLogger } from "@server/lib/logging/Loggable";

const execFileAsync = promisify(execFile);

export const CAMERA_HOOK_DYLIB_NAME = "BlueBubblesCameraHook.dylib";
export const CAMERA_HOOK_SANDBOX_DIR = "/private/var/tmp/AVConference";
export const CAMERA_HOOK_INSTALLED_PATH = path.join(CAMERA_HOOK_SANDBOX_DIR, CAMERA_HOOK_DYLIB_NAME);
export const CAMERA_HOOK_MARKER_PATH = path.join(CAMERA_HOOK_SANDBOX_DIR, "BlueBubblesCameraHook.sha256");
export const CAMERA_HOOK_ACTIVE_FLAG_PATH = path.join(CAMERA_HOOK_SANDBOX_DIR, "bb-camera.active");
export const CAMERA_HOOK_SERVICE_LABEL = "com.apple.videoconference.camera";

export function setCameraHookActiveFlag(active: boolean): void {
    if (process.platform !== "darwin") return;
    try {
        if (active) {
            fs.mkdirSync(CAMERA_HOOK_SANDBOX_DIR, { recursive: true, mode: 0o755 });
            fs.writeFileSync(CAMERA_HOOK_ACTIVE_FLAG_PATH, String(Date.now()));
        } else if (fs.existsSync(CAMERA_HOOK_ACTIVE_FLAG_PATH)) {
            fs.unlinkSync(CAMERA_HOOK_ACTIVE_FLAG_PATH);
        }
    } catch {
        // Best-effort flag for clamshell camera hook
    }
}

const COMMAND_TIMEOUT_MS = 5000;
// com.apple.videoconference.camera has minimum runtime = 10s + exit timeout = 5s (~14-15s kickstart)
const KICKSTART_TIMEOUT_MS = 25000;

export type CameraHookResult = {
    ok: boolean;
    changed: boolean;
    skippedReason?: string;
    path?: string;
};

export function getCameraHookServiceTarget(uid?: number): string {
    const resolvedUid = uid ?? (typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid);
    return `gui/${resolvedUid}/${CAMERA_HOOK_SERVICE_LABEL}`;
}

export function resolveCameraHookDylibPath(): string | null {
    const macVer = isMinMonterey ? "macos11" : isMinBigSur ? "macos11" : "macos10";
    const candidates: string[] = [];

    try {
        if (FileSystem?.resources) {
            candidates.push(path.join(FileSystem.resources, "private-api", macVer, CAMERA_HOOK_DYLIB_NAME));
        }
    } catch {
        // Ignore when FileSystem/Electron is unavailable (e.g. unit tests)
    }

    candidates.push(
        path.resolve(__dirname, "../../../../../appResources/private-api", macVer, CAMERA_HOOK_DYLIB_NAME),
        path.resolve(process.cwd(), "appResources/private-api", macVer, CAMERA_HOOK_DYLIB_NAME)
    );

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

export async function isSipDisabled(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
        const { stdout, stderr } = await execFileAsync("csrutil", ["status"], { timeout: COMMAND_TIMEOUT_MS });
        const combined = `${stdout ?? ""}\n${stderr ?? ""}`.toLowerCase();
        return combined.includes("disabled");
    } catch {
        return false;
    }
}

export async function isCameraHookEnabled(): Promise<boolean> {
    if (process.platform !== "darwin") return false;

    if (await isSipDisabled()) return true;

    try {
        const raw = Server()?.repo?.getConfig("facetime_camera_uplink");
        if (raw !== undefined && raw !== null) {
            if (typeof raw === "boolean") return raw;
            if (typeof raw === "number") return raw !== 0;
            const normalized = String(raw).trim().toLowerCase();
            if (normalized === "false" || normalized === "0" || normalized === "no") return false;
            if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
        }
    } catch {
        // Ignore when Server singleton/repo is not initialized
    }

    return false;
}

function sha256File(filePath: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hasActiveFaceTimeCall(): boolean {
    try {
        return FaceTimeSessionManager().listActiveSessions().length > 0;
    } catch {
        return false;
    }
}

async function runLaunchctl(
    args: string[],
    useSudo = false,
    timeoutMs = COMMAND_TIMEOUT_MS
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const cmd = useSudo ? "sudo" : "launchctl";
    const fullArgs = useSudo ? ["-n", "launchctl", ...args] : args;
    try {
        const { stdout, stderr } = await execFileAsync(cmd, fullArgs, { timeout: timeoutMs });
        return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (error: any) {
        return {
            ok: false,
            stdout: error?.stdout ?? "",
            stderr: error?.stderr ?? error?.message ?? String(error)
        };
    }
}

async function runLaunchctlDebug(args: string[]): Promise<{ ok: boolean; stderr: string }> {
    // launchctl debug typically requires root; prefer direct when already root, else sudo -n with fallback
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (isRoot) {
        return runLaunchctl(["debug", ...args], false);
    }
    const sudoRes = await runLaunchctl(["debug", ...args], true);
    if (sudoRes.ok) return sudoRes;
    return runLaunchctl(["debug", ...args], false);
}

async function isLaunchdEnvInstalled(serviceTarget: string, dylibPath: string): Promise<boolean> {
    const res = await runLaunchctl(["print", serviceTarget], false);
    if (!res.ok) return false;
    if (res.stdout.includes("DYLD_INSERT_LIBRARIES") && res.stdout.includes(dylibPath)) {
        return true;
    }
    const pidMatch = res.stdout.match(/\bpid\s*=\s*(\d+)/);
    if (!pidMatch) return false;
    try {
        const { stdout } = await execFileAsync("lsof", ["-n", "-P", "-p", pidMatch[1]], {
            timeout: COMMAND_TIMEOUT_MS
        });
        return (stdout ?? "").includes(dylibPath);
    } catch {
        return false;
    }
}

function ensureSafeSandboxDir(dirPath: string): void {
    const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
    try {
        const st = fs.lstatSync(dirPath);
        if (st.isSymbolicLink() || !st.isDirectory()) {
            fs.unlinkSync(dirPath);
        } else if (st.uid !== uid) {
            const rmSync = (
                fs as unknown as {
                    rmSync?: (p: string, o: { recursive?: boolean; force?: boolean }) => void;
                }
            ).rmSync;
            if (typeof rmSync === "function") {
                rmSync(dirPath, { recursive: true, force: true });
            } else {
                fs.rmdirSync(dirPath, { recursive: true });
            }
        }
    } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
    }

    fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
    fs.chmodSync(dirPath, 0o755);

    const verified = fs.lstatSync(dirPath);
    if (verified.isSymbolicLink() || !verified.isDirectory() || verified.uid !== uid) {
        throw new Error(`Unsafe camera hook directory: ${dirPath}`);
    }
}

export function installDylibAtomically(sourcePath: string, destPath: string, mode = 0o644): void {
    const stagedPath = `${destPath}.tmp.${process.pid}`;
    try {
        fs.unlinkSync(stagedPath);
    } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
    }
    const dylibBytes = fs.readFileSync(sourcePath);
    const fd = fs.openSync(stagedPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    try {
        try {
            fs.writeFileSync(fd, dylibBytes);
            fs.fchmodSync(fd, mode);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(stagedPath, destPath);
    } catch (err) {
        try {
            fs.unlinkSync(stagedPath);
        } catch {
            // Best-effort cleanup of staged temp file
        }
        throw err;
    }
}

export async function ensureCameraHookInstalled(options: { force?: boolean } = {}): Promise<CameraHookResult> {
    const log = getLogger("FaceTimeCameraHook");
    if (process.platform !== "darwin") {
        return { ok: false, changed: false, skippedReason: "unsupported-platform" };
    }

    if (!(await isCameraHookEnabled())) {
        return { ok: false, changed: false, skippedReason: "disabled" };
    }

    if (!(await isSipDisabled())) {
        log.debug("Skipping FaceTime camera hook install because SIP is enabled");
        return { ok: false, changed: false, skippedReason: "sip-enabled" };
    }

    const sourceDylib = resolveCameraHookDylibPath();
    if (!sourceDylib) {
        log.debug(`Skipping FaceTime camera hook install; ${CAMERA_HOOK_DYLIB_NAME} not found`);
        return { ok: false, changed: false, skippedReason: "dylib-missing" };
    }

    const serviceTarget = getCameraHookServiceTarget();

    try {
        const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
        const sourceHash = sha256File(sourceDylib);
        if (!options.force && fs.existsSync(CAMERA_HOOK_INSTALLED_PATH) && fs.existsSync(CAMERA_HOOK_MARKER_PATH)) {
            const dirStat = fs.lstatSync(CAMERA_HOOK_SANDBOX_DIR);
            const fileStat = fs.lstatSync(CAMERA_HOOK_INSTALLED_PATH);
            const dirSafe = !dirStat.isSymbolicLink() && dirStat.isDirectory() &&
                dirStat.uid === uid && (dirStat.mode & 0o022) === 0;
            const fileSafe = !fileStat.isSymbolicLink() && fileStat.isFile() &&
                fileStat.uid === uid && (fileStat.mode & 0o022) === 0;
            const markerHash = fs.readFileSync(CAMERA_HOOK_MARKER_PATH, "utf8").trim();
            const installedHash = sha256File(CAMERA_HOOK_INSTALLED_PATH);
            const envInstalled = await isLaunchdEnvInstalled(
                serviceTarget,
                CAMERA_HOOK_INSTALLED_PATH
            );
            if (dirSafe && fileSafe && markerHash === sourceHash && installedHash === sourceHash && envInstalled) {
                return { ok: true, changed: false, path: CAMERA_HOOK_INSTALLED_PATH };
            }
        }

        if (!options.force && hasActiveFaceTimeCall()) {
            log.debug("Deferring FaceTime camera hook install while a FaceTime call is active");
            return { ok: false, changed: false, skippedReason: "active-call" };
        }

        ensureSafeSandboxDir(CAMERA_HOOK_SANDBOX_DIR);
        installDylibAtomically(sourceDylib, CAMERA_HOOK_INSTALLED_PATH, 0o644);

        const debugRes = await runLaunchctlDebug([
            serviceTarget,
            "--environment",
            `DYLD_INSERT_LIBRARIES=${CAMERA_HOOK_INSTALLED_PATH}`
        ]);
        if (!debugRes.ok) {
            log.warn(`launchctl debug failed for ${serviceTarget}: ${debugRes.stderr.trim()}`);
            return { ok: false, changed: false, skippedReason: "launchctl-debug-failed" };
        }

        const kickRes = await runLaunchctl(["kickstart", "-k", serviceTarget], false, KICKSTART_TIMEOUT_MS);
        if (!kickRes.ok) {
            log.warn(`launchctl kickstart failed for ${serviceTarget}: ${kickRes.stderr.trim()}`);
            return { ok: false, changed: false, skippedReason: "launchctl-kickstart-failed" };
        }

        fs.writeFileSync(CAMERA_HOOK_MARKER_PATH, `${sourceHash}\n`, { mode: 0o644 });
        log.info(`Installed FaceTime camera hook into ${serviceTarget}`);
        return { ok: true, changed: true, path: CAMERA_HOOK_INSTALLED_PATH };
    } catch (error: any) {
        log.warn(`Failed to install FaceTime camera hook: ${error?.message ?? String(error)}`);
        return { ok: false, changed: false, skippedReason: "error" };
    }
}

export async function removeCameraHook(options: { force?: boolean } = {}): Promise<CameraHookResult> {
    const log = getLogger("FaceTimeCameraHook");
    if (process.platform !== "darwin") {
        return { ok: false, changed: false, skippedReason: "unsupported-platform" };
    }

    if (!options.force && hasActiveFaceTimeCall()) {
        log.debug("Deferring FaceTime camera hook removal while a FaceTime call is active");
        return { ok: false, changed: false, skippedReason: "active-call" };
    }

    const serviceTarget = getCameraHookServiceTarget();

    try {
        const hadEnv = await isLaunchdEnvInstalled(serviceTarget, CAMERA_HOOK_INSTALLED_PATH);
        let changed = false;

        if (hadEnv || options.force) {
            // Clear custom environment variables on the service and restart it before unlinking dylib
            const debugRes = await runLaunchctlDebug([serviceTarget, "--environment", "DYLD_INSERT_LIBRARIES="]);
            if (!debugRes.ok) {
                log.warn(`launchctl debug reset failed for ${serviceTarget}: ${debugRes.stderr.trim()}`);
                return { ok: false, changed: false, skippedReason: "launchctl-debug-failed" };
            }
            const kickRes = await runLaunchctl(["kickstart", "-k", serviceTarget], false, KICKSTART_TIMEOUT_MS);
            if (!kickRes.ok) {
                log.warn(`launchctl kickstart failed for ${serviceTarget}: ${kickRes.stderr.trim()}`);
                return { ok: false, changed: false, skippedReason: "launchctl-kickstart-failed" };
            }
            changed = true;
        }

        for (const p of [CAMERA_HOOK_MARKER_PATH, CAMERA_HOOK_INSTALLED_PATH]) {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                changed = true;
            }
        }

        return { ok: true, changed };
    } catch (error: any) {
        log.warn(`Failed to remove FaceTime camera hook: ${error?.message ?? String(error)}`);
        return { ok: false, changed: false, skippedReason: "error" };
    }
}
