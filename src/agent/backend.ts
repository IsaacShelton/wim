// What the agent panel needs from Claude Code: starting a session (or
// resuming one), listing past sessions and reading their history. The real
// backend uses the Claude Agent SDK, which runs Claude Code as a child
// process; tests use a fake.

import type * as sdk from '@anthropic-ai/claude-agent-sdk';

export type {
    CanUseTool,
    EffortLevel,
    ModelInfo,
    PermissionMode,
    PermissionResult,
    PermissionUpdate,
    SDKControlGetUsageResponse as UsageInfo,
    SDKMessage,
    SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/** Claude Code's context breakdown, and what the session has cost so far for
 * backends that can say before a turn ends (OpenCode). */
export type ContextUsage = sdk.SDKControlGetContextUsageResponse & {
    cost?: number;
};

/** The part of the SDK's `Query` Wim uses: the session's messages, and
 * control requests while it runs. */
export interface AgentQuery extends AsyncIterable<sdk.SDKMessage> {
    interrupt(): Promise<unknown>;
    setModel(model?: string): Promise<void>;
    setPermissionMode(mode: sdk.PermissionMode): Promise<void>;
    applyFlagSettings(settings: { effortLevel?: sdk.EffortLevel | null }): Promise<void>;
    supportedModels(): Promise<sdk.ModelInfo[]>;
    getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<ContextUsage>;
    /** The plan's usage limits (5-hour, weekly), when Claude Code can say. */
    getUsage?(): Promise<sdk.SDKControlGetUsageResponse>;
    /** The process is being stopped before it took any message: forget the
     * empty session a backend may have made for it. Returns whether it did
     * (so the session's id no longer names anything). */
    abandon?(): boolean;
    close(): void;
}

export interface StartOptions {
    cwd: string;
    /** The user's messages, as they are sent. */
    prompt: AsyncIterable<sdk.SDKUserMessage>;
    /** A session to continue. */
    resume?: string;
    model?: string;
    permissionMode?: sdk.PermissionMode;
    effort?: sdk.EffortLevel;
    canUseTool: sdk.CanUseTool;
    /** Output from Claude Code's process, for error messages. */
    stderr: (data: string) => void;
}

/** What is left of an agent provider's account balance. */
export interface AccountBalance {
    /** Money left to spend, in `currency`. */
    available: number;
    /** The currency it is in (`USD`). */
    currency: string;
}

/** A sign-in waiting on the user, for when the provider's saved session has
 * expired and can't be refreshed. */
export interface SignIn {
    /** The page to open in a browser. */
    url: string;
    /** What to do there, such as the code to enter. */
    instructions: string;
    /** Resolves true once the provider has new credentials, false if the
     * attempt failed or expired. */
    done: Promise<boolean>;
}

/** A session saved on disk, which can be resumed. */
export interface PastSession {
    id: string;
    title: string;
    modified: number;
    branch?: string;
    /** Which agent backend saved it (`claude` or `opencode`). */
    backend?: string;
}

/** A message from a saved session's transcript, as the Messages API shapes
 * it (`{ role, content }`). */
export interface HistoryMessage {
    type: 'user' | 'assistant' | 'system';
    message: unknown;
    /** Set for a subagent's messages. */
    parentToolUseId: string | null;
}

export interface AgentBackend {
    /** Stable id, used to tell Claude Code from OpenCode (`claude`). */
    readonly id: string;
    /** The name shown in the panel's menus (`Claude Code`). */
    readonly label: string;
    start(opts: StartOptions): Promise<AgentQuery>;
    /** Sessions for the project in `dir`, most recent first. */
    listSessions(dir: string): Promise<PastSession[]>;
    history(id: string, dir: string): Promise<HistoryMessage[]>;
    /** The session's title (Claude Code names sessions after their first
     * messages). */
    title(id: string, dir: string): Promise<string | undefined>;
    /** The models this backend can use, without starting a session. */
    models?(dir: string): Promise<sdk.ModelInfo[]>;
    /** The provider account's remaining balance, when it has one. */
    balance?(dir: string): Promise<AccountBalance | undefined>;
    /** Sign in again, when the provider's saved session can't be refreshed. */
    signIn?(dir: string): Promise<SignIn>;
}

/** How many past sessions the session picker lists. */
const LIST_LIMIT = 100;

// The SDK is an ES module and Wim is compiled to CommonJS, whose `import()`
// TypeScript would turn into `require()`; this keeps a real `import()`.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

let loaded: Promise<typeof sdk> | undefined;

function load(): Promise<typeof sdk> {
    loaded ??= importModule('@anthropic-ai/claude-agent-sdk').then((m) => m as typeof sdk);
    return loaded;
}

function sessionTitle(s: sdk.SDKSessionInfo): string {
    return s.customTitle ?? s.summary ?? s.firstPrompt ?? s.sessionId;
}

/** Claude Code, through the Claude Agent SDK. */
export class SdkBackend implements AgentBackend {
    readonly id = 'claude';
    readonly label = 'Claude Code';

    async start(opts: StartOptions): Promise<AgentQuery> {
        const { query } = await load();
        const q = query({
            prompt: opts.prompt,
            options: {
                cwd: opts.cwd,
                resume: opts.resume,
                model: opts.model,
                permissionMode: opts.permissionMode,
                effort: opts.effort,
                // Claude Code's own system prompt, tools and settings, as in
                // the terminal.
                systemPrompt: { type: 'preset', preset: 'claude_code' },
                // So the mode picker can switch to it; it is never the default.
                allowDangerouslySkipPermissions: true,
                includePartialMessages: true,
                canUseTool: opts.canUseTool,
                stderr: opts.stderr,
            },
        });
        // The SDK's name for this says it may change; keep that to one place.
        return Object.assign(q, { getUsage: () => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) });
    }

    async listSessions(dir: string): Promise<PastSession[]> {
        const { listSessions } = await load();
        const sessions = await listSessions({ dir, limit: LIST_LIMIT });
        return sessions.map((s) => ({ id: s.sessionId, title: sessionTitle(s), modified: s.lastModified, branch: s.gitBranch }));
    }

    async history(id: string, dir: string): Promise<HistoryMessage[]> {
        const { getSessionMessages } = await load();
        const messages = await getSessionMessages(id, { dir });
        return messages.map((m) => ({ type: m.type, message: m.message, parentToolUseId: m.parent_tool_use_id }));
    }

    async title(id: string, dir: string): Promise<string | undefined> {
        const { getSessionInfo } = await load();
        const info = await getSessionInfo(id, { dir });
        return info && sessionTitle(info);
    }

    /** Claude Code's models, asked of a short-lived process (the SDK only
     * offers them from a session). */
    async models(dir: string): Promise<sdk.ModelInfo[]> {
        const { query } = await load();
        // Keep the query alive until its models arrive, then close it.
        const prompt = (async function* (): AsyncGenerator<sdk.SDKUserMessage> {
            await new Promise<never>(() => {});
        })();
        const q = query({ prompt, options: { cwd: dir } });
        try {
            return await q.supportedModels();
        } finally {
            q.close();
        }
    }
}
