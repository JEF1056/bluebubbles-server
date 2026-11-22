import { ScheduledService } from "@server/lib/ScheduledService";
import { Loggable } from "@server/lib/logging/Loggable";
import * as dns from "dns";

export class NetworkCheckerService extends Loggable {
    tag = "NetworkCheckerService";

    online = true;

    isStopped = false;

    private startGeneration = 0;

    serviceLoop: ScheduledService;

    async start() {
        this.stop();
        this.isStopped = false;
        const generation = ++this.startGeneration;

        // Let's get the initial network connection
        const online = await NetworkCheckerService.checkNetwork();
        if (this.isStopped || generation !== this.startGeneration) return;
        this.online = online;

        // Start the service loop
        this.serviceLoop?.stop();
        this.serviceLoop = new ScheduledService(async () => {
            if (this.isStopped || generation !== this.startGeneration) {
                this.serviceLoop?.stop();
                return;
            }

            // Check the network connection
            const nextOnline = await NetworkCheckerService.checkNetwork();
            if (this.isStopped || generation !== this.startGeneration) return;
            if (!this.online && nextOnline) {
                this.emit("status-change", true);
            } else if (this.online && !nextOnline) {
                this.emit("status-change", false);
            }

            this.online = nextOnline;
        }, 300000);
    }

    static async checkNetwork(): Promise<boolean> {
        try {
            await dns.promises.resolve("www.google.com");
            return true;
        } catch {
            return false;
        }
    }

    stop() {
        this.isStopped = true;
        this.startGeneration++;
        this.serviceLoop?.stop();
        this.serviceLoop = undefined;
    }
}
