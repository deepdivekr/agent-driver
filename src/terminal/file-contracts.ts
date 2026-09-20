import {z} from 'zod';

// Exact paths, not glob patterns. Hidden/config/auth paths are deliberately unavailable.
export const delegatedPath = z.string().min(1).max(240).refine(value => value.split('/').every(part => /^[\p{L}\p{N}_][\p{L}\p{N}_. -]*$/u.test(part) && !/[. ]$/.test(part)) && !/(?:^|\/)(?:node_modules|credentials?|secrets?|id_rsa|id_ed25519)(?:[./]|$)/i.test(value));
const shortText = z.string().max(8192);
export const fileDelegation = z.object({
  ownership: z.literal('exclusive_runtime'),
  read: z.array(delegatedPath).min(1).max(64), write: z.array(delegatedPath).max(32),
  max_bytes: z.number().int().min(1).max(262144).default(65536),
  max_writes_per_turn: z.number().int().min(1).max(32).default(8),
  verifier: z.object({
    kind: z.literal('node_stdio_cases'), entry: delegatedPath,
    cases: z.array(z.object({id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), args: z.array(z.string().max(256)).max(16).default([]), stdin: shortText.default(''), stdout: shortText, stderr: shortText.default(''), exit: z.number().int().min(0).max(125).default(0)}).strict()).min(1).max(32),
    timeout_ms: z.number().int().min(100).max(10000).default(3000),
  }).strict().optional(),
}).strict();
export type FileDelegation = z.infer<typeof fileDelegation>;
const turnId = z.string().uuid(), requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const fileRead = z.object({turn_id: turnId, path: delegatedPath}).strict();
export const fileWrite = fileRead.extend({request_id: requestId, expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().max(262144)}).strict();
export type FileWrite = z.infer<typeof fileWrite>;
export interface FileAuthority {session: string; generation: number; host: string; broker: string; cli: string}
export interface FileIntent {id: string; session_id: string; turn_id: string; generation: number; path: string; request_id: string; request_hash: string; before_hash: string | null; after_hash: string; before_content: string | null; content: string; status: 'intent' | 'verified' | 'uncertain' | 'not_applied'; result_json: string | null}
export const brokerTools = ['mcp__runtime_files__read_file', 'mcp__runtime_files__write_file'] as const;
export function wirePrompt(id: string, prompt: string, enabled: boolean) {return enabled ? `Runtime turn_id: ${id}. Use this exact turn_id for every runtime_files tool call. Only host-delegated files are available. Read before writing; use the observed SHA256 (null only for a missing file). A write is not a test or project completion.\n\nUser task:\n${prompt}` : prompt;}
