import * as fs from "fs";
import { Server } from "@server";
import { isNotEmpty } from "@server/helpers/utils";
import { requestFindMyAutomation, requestSystemEventsAutomation } from "@server/api/apple/scripts";
import { FileSystem } from ".";

export async function requestFindMyAutomationPermissions() {
    const requests = [
        { name: "System Events", script: requestSystemEventsAutomation() },
        { name: "Find My", script: requestFindMyAutomation() }
    ];

    for (const request of requests) {
        try {
            await FileSystem.executeAppleScript(request.script);
            Server().logger.debug(`Requested ${request.name} Automation permission`);
        } catch (ex: any) {
            Server().logger.warn(
                `Unable to request ${request.name} Automation permission! CLI Error: ${ex?.message ?? String(ex)}`
            );
        }
    }
}

export async function hasAlpha(filePath: string): Promise<boolean> {
    const oldPath = FileSystem.getRealPath(filePath);
    if (!oldPath || !fs.existsSync(oldPath)) return false;
    try {
        const output = await FileSystem.execFileCommand("/usr/bin/sips", ["-g", "hasAlpha", oldPath]);
        return typeof output === "string" && /hasAlpha:\s*yes/i.test(output);
    } catch {
        return false;
    }
}

export async function convertToPng(originalPath: string, outputPath: string): Promise<void> {
    const oldPath = FileSystem.getRealPath(originalPath);
    const output = await FileSystem.execFileCommand("/usr/bin/sips", [
        "--setProperty",
        "format",
        "png",
        oldPath,
        "--out",
        outputPath
    ]);
    if (isNotEmpty(output) && output.includes("Error:")) {
        throw Error(`Failed to convert image to PNG: ${output}`);
    }
}
