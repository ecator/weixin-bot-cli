import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import { AcpManager } from './client.js'; // Assuming module resolution maps it correctly or uses .js

// Mock child_process
vi.mock('node:child_process', () => {
    return {
        spawn: vi.fn().mockReturnValue({
            stdin: {},
            stdout: {},
            kill: vi.fn(),
            killed: false,
        }),
    };
});

// Mock node:stream's toWeb conversions
vi.mock('node:stream', () => {
    return {
        Writable: { toWeb: vi.fn().mockReturnValue({}) },
        Readable: { toWeb: vi.fn().mockReturnValue({}) },
    };
});

// Mock @agentclientprotocol/sdk
vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...(actual as any),
        ndJsonStream: vi.fn().mockReturnValue({}),
        ClientSideConnection: vi.fn().mockImplementation(() => {
            return {
                initialize: vi.fn().mockResolvedValue({}),
                listSessions: vi.fn().mockResolvedValue({
                    sessions: [{ sessionId: 'session-123' }],
                    nextCursor: null,
                }),
                newSession: vi.fn().mockResolvedValue({ sessionId: 'session-456' }),
                loadSession: vi.fn().mockResolvedValue({}),
                prompt: vi.fn().mockImplementation(async (req: any) => {
                    if (req.sessionId === 'invalid-session') {
                        throw new Error('Session ID does not exist');
                    }
                    return {};
                }),
            };
        }),
    };
});

describe('AcpManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should initialize correctly via constructor', () => {
        const manager = new AcpManager('fake-cmd', ['--arg1']);
        expect(manager).toBeInstanceOf(AcpManager);
    });

    it('should connect and initialize connection correctly', async () => {
        const manager = new AcpManager('fake-cmd', ['--arg1']);

        const initResult = await manager.connect();

        expect(spawn).toHaveBeenCalled();
        expect(acp.ClientSideConnection).toHaveBeenCalled();
        expect(initResult).toBeDefined();
    });

    it('should list sessions', async () => {
        const manager = new AcpManager('fake-cmd', ['--arg1']);
        await manager.connect();

        const sessions = await manager.listSessions();
        expect(sessions).toContain('session-123');
        expect(sessions.length).toBe(1);
    });

    it('should throw an error when listing sessions without connection', async () => {
        const manager = new AcpManager('fake-cmd', []);
        await expect(manager.listSessions()).rejects.toThrow('Connection not initialized');
    });

    it('should create a new session', async () => {
        const manager = new AcpManager('fake-cmd', []);
        await manager.connect();

        const sessionId = await manager.createSession();
        expect(sessionId).toBe('session-456');
    });

    it('should throw an error when creating session without connection', async () => {
        const manager = new AcpManager('fake-cmd', []);
        await expect(manager.createSession()).rejects.toThrow('Connection not initialized');
    });

    it('should load a session', async () => {
        const manager = new AcpManager('fake-cmd', []);
        await manager.connect();

        await expect(manager.loadSession('session-123')).resolves.toBeUndefined();
    });

    it('should throw an error when loading session without connection', async () => {
        const manager = new AcpManager('fake-cmd', []);
        await expect(manager.loadSession('session-123')).rejects.toThrow('Connection not initialized');
    });

    it('should prompt in a session', async () => {
        const manager = new AcpManager('fake-cmd', []);
        await manager.connect();
        await manager.listSessions(); // Needs sessions to be non-empty

        // This will rely on the listSessions mock adding 'session-123'
        const result = await manager.prompt('session-123', [{ type: 'text', text: 'Hello world' }]);

        // Since Client side agentMessage is empty when initialized directly, it returns an empty string unless we simulate sessionUpdate
        expect(result).toBe('');
    });

    it('should throw an error when prompting an invalid session', async () => {
        const manager = new AcpManager('fake-cmd', []);
        await manager.connect();
        await manager.listSessions();

        await expect(manager.prompt('invalid-session', [{ type: 'text', text: 'text' }])).rejects.toThrow('Session ID does not exist');
    });

    it('should throw an error when connecting twice', async () => {
        const manager = new AcpManager('fake-cmd', []);
        await manager.connect();
        await expect(manager.connect()).rejects.toThrow('Connection already initialized. Call close() first.');
    });

    it('should close correctly', async () => {
        const manager = new AcpManager('fake-cmd', []);
        await manager.connect();
        manager.close();

        // Ensure child process kill is called
        // We mocked spawn to return an object with a kill method
        const spawnMockResult = vi.mocked(spawn).mock.results[0].value;
        expect(spawnMockResult.kill).toHaveBeenCalled();
    });
});
