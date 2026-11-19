/* eslint-disable max-classes-per-file */
import * as fs from "fs";
import { RouterContext } from "koa-router";
import { ResponseFormat, ResponseMessages, ResponseParams, ValidStatuses } from "./types";

type ResponseClasses = ResponseParams | string | fs.ReadStream;

type ResponseTypes = "json" | "html" | "file";

function normalizeMalformedSurrogates(value: string): string {
    let normalized = "";
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                normalized += value[i] + value[i + 1];
                i += 1;
            } else {
                normalized += "\ufffd";
            }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            normalized += "\ufffd";
        } else {
            normalized += value[i];
        }
    }
    return normalized;
}

export function attachmentContentDisposition(filename: string): string {
    const normalized = normalizeMalformedSurrogates(filename);
    const fallback = normalized.replace(/[^\x20-\x7e]|["\\]/gu, "_");
    const disposition = `attachment; filename="${fallback}"`;
    if (fallback === filename) return disposition;

    const encoded = encodeURIComponent(normalized).replace(/[!'()*]/g, char =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `${disposition}; filename*=UTF-8''${encoded}`;
}

export class HTTPResponse {
    ctx: RouterContext;

    status: ValidStatuses;

    response: ResponseFormat;

    type: ResponseTypes;

    constructor(
        ctx: RouterContext,
        status: ValidStatuses,
        response: ResponseClasses,
        responseType: ResponseTypes = "json"
    ) {
        this.ctx = ctx;
        this.status = status;
        this.type = responseType;

        // Load the data based on the response type
        if (responseType === "json") {
            // Reload the data with conditional keys
            const res = response as ResponseParams;
            this.response = { status, message: res?.message ?? "No Message Response" };
            if (res?.data !== undefined) this.response.data = res.data;
            if (res?.metadata !== undefined) this.response.metadata = res.metadata;
        } else if (responseType === "html") {
            this.response = response as string;
        } else if (responseType === "file") {
            this.response = response as fs.ReadStream;
        }
    }

    send() {
        this.ctx.status = this.status;
        this.ctx.body = this.response;
    }

    toString() {
        if (this.type === "json") {
            const res = this.response as ResponseParams;
            return `[${this.status}] ${res?.message ?? res?.error ?? "No Response"}`;
        }

        if (this.type === "html") {
            return this.response;
        }

        if (this.type === "file") {
            return `File: ${(this.response as fs.ReadStream).readableLength} bytes`;
        }

        return "";
    }
}

export class Success extends HTTPResponse {
    constructor(ctx: RouterContext, response: ResponseParams) {
        const data: ResponseParams = { message: response?.message ?? ResponseMessages.SUCCESS };
        if (response?.data !== undefined) data.data = response.data;
        if (response?.metadata !== undefined) data.metadata = response.metadata;
        super(ctx, 200, data);
    }
}

export class FileStream extends HTTPResponse {
    constructor(ctx: RouterContext, path: string, mimeType = "application/octet-stream") {
        const stats = fs.statSync(path);
        const total = stats.size;
        const filename = path.split("/").pop() ?? "attachment";
        const rangeHeader = ctx.request?.headers?.range ?? ctx.headers?.range;
        const rangeMatch = typeof rangeHeader === "string" ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;

        ctx.response.set("Accept-Ranges", "bytes");

        if (rangeMatch && (rangeMatch[1] !== "" || rangeMatch[2] !== "")) {
            let start: number;
            let end: number;
            if (rangeMatch[1] === "") {
                const suffixLen = Number.parseInt(rangeMatch[2], 10);
                start = Math.max(0, total - suffixLen);
                end = total - 1;
            } else {
                start = Number.parseInt(rangeMatch[1], 10);
                end = rangeMatch[2] === "" ? total - 1 : Math.min(Number.parseInt(rangeMatch[2], 10), total - 1);
            }

            if (total === 0 || Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= total || start > end) {
                ctx.response.set("Content-Range", `bytes */${total}`);
                ctx.response.set("Content-Length", "0");
                super(ctx, 416 as ValidStatuses, "", "html");
                return;
            }

            const src = fs.createReadStream(path, { start, end });
            ctx.response.set("Content-Type", mimeType as string);
            ctx.response.set("Content-Range", `bytes ${start}-${end}/${total}`);
            ctx.response.set("Content-Length", (end - start + 1).toString());
            ctx.response.set("Content-Disposition", attachmentContentDisposition(filename));
            super(ctx, 206 as ValidStatuses, src, "file");
            return;
        }

        const src = fs.createReadStream(path);
        ctx.response.set("Content-Type", mimeType as string);
        // Set the content-length header so that clients can show download progress
        ctx.response.set("Content-Length", total.toString());
        ctx.response.set("Content-Disposition", attachmentContentDisposition(filename));
        super(ctx, 200, src, "file");
    }
}

export class HTML extends HTTPResponse {
    constructor(ctx: RouterContext, response: string) {
        super(ctx, 200, response, "html");
    }
}

export class NoData extends HTTPResponse {
    constructor(ctx: RouterContext, response: ResponseParams) {
        const data: ResponseParams = { message: response?.message ?? ResponseMessages.NO_DATA };
        super(ctx, 201, data);
    }
}
