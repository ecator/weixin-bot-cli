import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Writable, Readable } from "node:stream";
import readline from "node:readline/promises";

import * as acp from "@agentclientprotocol/sdk";

class Client implements acp.Client {
    /** Collected response chunks; joined only when prompt() returns. */
    public messageChunks: string[] = [];

    /** Reset chunk buffer — call at the start of each prompt. */
    resetMessage(): void {
        this.messageChunks = [];
    }

    /** Join collected chunks into the final reply string and reset the buffer. */
    getFullMessage(): string {
        const msg = this.messageChunks.join("");
        this.resetMessage();
        return msg;
    }

    async requestPermission(
        params: acp.RequestPermissionRequest,
    ): Promise<acp.RequestPermissionResponse> {
        console.log(`\n🔐 Permission requested: ${params.toolCall.title}`);

        console.log(`\nOptions:`);
        params.options.forEach((option, index) => {
            console.log(`   ${index + 1}. ${option.name} (${option.kind})`);
        });
        // 永远回复allow
        for (const option of params.options) {
            if (option.kind.startsWith("allow_")) {
                console.log(`   ✅ Auto selected<allow>: ${option.name}`);
                return {
                    outcome: {
                        outcome: "selected",
                        optionId: option.optionId,
                    },
                };
            }
        }
        // 如果没有allow选项，就返回第一个
        console.log(`   ✅ Auto selected<first>: ${params.options[0].name}`);
        return {
            outcome: {
                outcome: "selected",
                optionId: params.options[0].optionId,
            },
        };
    }

    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
        const update = params.update;
        console.log(`\n⚡[${update.sessionUpdate}]`);
        switch (update.sessionUpdate) {
            case "agent_message_chunk":
                console.log(`  🤖[${update.content.type}]`);
                if (update.content.type === "text") {
                    process.stdout.write(update.content.text);
                    this.messageChunks.push(update.content.text);
                }
                break;
            case "tool_call":
                console.log(`  🔧 ${update.title} (${update.status})`);
                break;
            case "tool_call_update":
                console.log(
                    `  🔧 Tool call \`${update.toolCallId}\` updated: ${update.status}\n`,
                );
                break;
            case "plan":
                console.log(`  📋\n${update.entries.map(entry => entry.status + " - " + entry.content).join("\n")}`);
                break;
            case "agent_thought_chunk":
                console.log(`  💭${update.content.type}`);
                if (update.content.type === "text") {
                    process.stdout.write(update.content.text);
                }
                break;
            case "user_message_chunk":
                console.log(`  👤[${update.content.type}]`);
                if (update.content.type === "text") {
                    process.stdout.write(update.content.text);
                }
                break;
            case "available_commands_update":
                console.log(JSON.stringify(update.availableCommands, null, 2));
                break;
            default:
                break;
        }
    }

    async writeTextFile(
        params: acp.WriteTextFileRequest,
    ): Promise<acp.WriteTextFileResponse> {
        fs.writeFileSync(params.path, params.content, 'utf8');

        return {};
    }

    async readTextFile(
        params: acp.ReadTextFileRequest,
    ): Promise<acp.ReadTextFileResponse> {
        if (!fs.existsSync(params.path)) {
            return {
                content: "",
            };
        }
        const stream = fs.createReadStream(params.path, 'utf8');
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        const content: string[] = [];
        let i = 0;
        const startLine = Math.max(params.line ?? 1, 1);
        const endLine = params.limit ? startLine + params.limit - 1 : Number.MAX_VALUE;
        try {
            for await (const line of rl) {
                i++;
                if (i >= startLine && i <= endLine) {
                    content.push(line);
                }
                if (i > endLine) {
                    break;
                }
            }
        } finally {
            rl.close();
            stream.destroy();
        }

        return {
            content: content.join('\n'),
        };
    }
}

export class AcpManager {
    private agentProcess: ChildProcess | null = null;
    private connection: acp.ClientSideConnection | null = null;
    private sessions: Set<string> = new Set();
    private agentCmd: string;
    private agentArgs: string[];
    private client: Client;

    constructor(agentCmd: string, agentArgs: string[]) {
        this.agentCmd = agentCmd;
        this.agentArgs = agentArgs;
        this.client = new Client();
    }

    public async connect(): Promise<acp.InitializeResponse> {
        if (this.connection) {
            throw new Error("Connection already initialized. Call close() first.");
        }
        // Spawn the agent as a subprocess
        const cmd = process.platform === "win32" ?
            ["cmd", "/c", this.agentCmd, ...this.agentArgs] :
            ["bash", "-c", `${this.agentCmd} ${this.agentArgs.join(" ")}`];
        this.agentProcess = spawn(cmd[0], cmd.slice(1), {
            stdio: ["pipe", "pipe", "inherit"],
        });

        // Create streams to communicate with the agent
        const input = Writable.toWeb(this.agentProcess.stdin!);
        const output = Readable.toWeb(
            this.agentProcess.stdout!,
        ) as ReadableStream<Uint8Array>;

        // Create the client connection
        const stream = acp.ndJsonStream(input, output);
        this.connection = new acp.ClientSideConnection((_agent) => this.client, stream);

        // Initialize the connection
        const initResult = await this.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
                fs: {
                    readTextFile: true,
                    writeTextFile: true,
                },
            },
        });
        return initResult;
    }

    public async listSessions(cwd?: string): Promise<string[]> {
        if (!this.connection) {
            throw new Error("Connection not initialized. Call connect() first.");
        }
        try {
            let nextCursor = null;
            let newSessions = new Set<string>();
            do {
                const sessionResult = await this.connection.listSessions({ cwd: cwd ?? process.cwd(), cursor: nextCursor });
                nextCursor = sessionResult.nextCursor;
                sessionResult.sessions.forEach((sessionInfo: acp.SessionInfo) => {
                    newSessions.add(sessionInfo.sessionId);
                });

            } while (nextCursor)
            this.sessions = newSessions;
        } catch (error) {
            console.error("Failed to list sessions:", error);
        }
        return Array.from(this.sessions);
    }

    public async loadSession(sessionId: string, cwd?: string, mcpServers?: any[]): Promise<void> {
        if (!this.connection) {
            throw new Error("Connection not initialized. Call connect() first.");
        }
        await this.connection.loadSession({
            sessionId: sessionId,
            cwd: cwd ?? process.cwd(),
            mcpServers: mcpServers ?? [],
        });
    }

    public async createSession(opts?: { cwd?: string; mcpServers?: any[] }): Promise<string> {
        if (!this.connection) {
            throw new Error("Connection not initialized. Call connect() first.");
        }

        const sessionResult = await this.connection.newSession({
            cwd: opts?.cwd ?? process.cwd(),
            mcpServers: opts?.mcpServers ?? [],
        });

        this.sessions.add(sessionResult.sessionId);
        return sessionResult.sessionId;
    }

    /**
     * Send a prompt and return the agent's full text reply.
     * Includes a timeout guard (default 10 min) to prevent indefinite hangs.
     */
    public async prompt(sessionId: string, text: string, timeoutMs = 10 * 60 * 1000): Promise<string> {
        if (!this.connection) {
            throw new Error("Connection not initialized. Call connect() first.");
        }

        this.client.resetMessage();

        const promptPromise = this.connection.prompt({
            sessionId: sessionId,
            prompt: [
                {
                    type: "text",
                    text: text,
                },
            ],
        });

        // Guard against Agent hanging forever (and chunks piling up).
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                this.connection?.cancel({ sessionId: sessionId });
                reject(new Error(`ACP prompt timed out after ${timeoutMs / 1000}s`));
            }, timeoutMs);
            // Allow the process to exit even if this timer is pending.
            if (typeof timeoutHandle === "object" && "unref" in timeoutHandle) timeoutHandle.unref();
        });

        try {
            await Promise.race([promptPromise, timeoutPromise]);
        } finally {
            // Clear the timer so it won't fire a stray reject (unhandled rejection)
            // after promptPromise has already won the race.
            clearTimeout(timeoutHandle);
        }

        return this.client.getFullMessage();
    }

    public close(): void {
        if (this.agentProcess && !this.agentProcess.killed) {
            this.agentProcess.kill();
            this.agentProcess = null;
            this.connection = null;
            this.sessions.clear();
        }
    }
}
