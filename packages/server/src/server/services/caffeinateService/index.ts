import * as process from "process";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { Loggable } from "@server/lib/logging/Loggable";

/**
 * Service that spawns the caffeinate process so that
 * the macOS operating system does not sleep until the server
 * exits.
 */
export class CaffeinateService extends Loggable {
    tag = "CaffeinateService";

    isCaffeinated = false;

    childProc: ChildProcessWithoutNullStreams | null;

    /**
     * Runs caffeinate until the current process is killed
     */
    start() {
        if (this.isCaffeinated) return;
        const myPid = process.pid;

        // Spawn the child process
        // -i: Create an assertion to prevent the system from idle sleeping.
        // -s: Create an assertion to prevent the system from sleeping
        // -w: Waits for the process with the specified pid to exit.
        const proc = spawn("caffeinate", ["-i", "-s", "-w", myPid.toString()], { detached: true });
        this.childProc = proc;
        this.log.info(`Spawned Caffeinate with PID: ${proc.pid}`);
        this.isCaffeinated = true;

        // Setup listeners bound to this specific child so stale close events cannot clear a newer child
        const onChildClose = () => this.onClose(proc);
        proc.on("close", onChildClose);
        proc.on("exit", onChildClose);
        proc.on("disconnect", onChildClose);
        proc.on("error", onChildClose);
    }

    /**
     * Stops being caffeinated
     */
    stop() {
        if (!this.isCaffeinated) return;
        if (this.childProc && this.childProc.pid) {
            // Kill the process
            try {
                const killed = this.childProc.kill();
                if (!killed) process.kill(-this.childProc.pid);
                this.log.debug("Killed caffeinate process");
            } catch (ex: any) {
                this.log.error(`Failed to kill caffeinate process! ${ex.message}`);
            } finally {
                this.isCaffeinated = false;
                this.childProc = null;
            }
        }
    }

    /**
     * Method to let us know that the caffeinate process has ended
     */
    private onClose(proc: ChildProcessWithoutNullStreams) {
        if (proc !== this.childProc) return;
        this.isCaffeinated = false;
        this.childProc = null;
    }
}
