import {z} from 'zod';
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const legacyWorkflowPolicy=z.record(z.string().min(1).max(80),z.unknown());
const moduleBinding=z.object({path:z.string().min(1).max(4096),sha256:sha}).strict();
export const workflowBridgeSchema=z.object({
  protocol:z.literal('local-workflow-v1'),runtime:moduleBinding,contracts:moduleBinding,policy_sha256:sha,
}).strict();
export type WorkflowBridge=z.infer<typeof workflowBridgeSchema>;
