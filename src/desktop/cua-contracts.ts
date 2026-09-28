import {z} from 'zod';
const digest=z.string().regex(/^[a-f0-9]{64}$/u);
/** Local host configuration, not an MCP argument. A reviewed exact draft grant
 * is consumed once on dispatch, even if the response is lost. */
export const windowsCuaConfigSchema=z.object({
  kind:z.literal('cua'),executable:z.string().min(1),executable_sha256:digest,
  version:z.literal('0.30.2'),manifest:z.string().min(1),manifest_sha256:digest,
  manifest_reviewed:z.literal(true),
  observation_strategy:z.enum(['focused','full']).default('focused'),
  fields:z.array(z.object({
    grant_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    work_id:z.string().uuid(),pid:z.number().int().positive(),window_id:z.number().int().positive(),
    app_name:z.string().min(1).max(160),window_title:z.string().min(1).max(160),
    element_index:z.number().int().nonnegative(),label:z.string().min(1).max(160),
    request_field:z.string().min(1).max(512),expires_at_ms:z.number().int().positive(),
    value_encoding:z.enum(['exact','uia_single_line_document']).default('exact'),
    local_draft_only:z.literal(true),auto_submits:z.literal(false),sensitive:z.literal(false),
    approved_value:z.string().min(1).max(512).optional(),
  }).strict()).min(1).max(8),
}).strict();
export type WindowsCuaConfig=z.infer<typeof windowsCuaConfigSchema>;

/** Scope is user/host permission, not an app adapter: no field indices,
 * workflow IDs, recipient restrictions or per-app behavior are configured. */
export const windowsDesktopCuaConfigSchema=windowsCuaConfigSchema.omit({kind:true,fields:true,observation_strategy:true}).extend({
  kind:z.literal('cua-desktop'),
  grants:z.array(z.object({
    grant_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    work_id:z.string().uuid(),expires_at_ms:z.number().int().positive(),
    effects:z.array(z.enum(['navigate','local_draft','local_write','external_send'])).min(1).max(4),
    windows:z.array(z.object({
      ref:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
      pid:z.number().int().positive(),window_id:z.number().int().positive(),
      app_name:z.string().min(1).max(160),title:z.string().min(1).max(160),
      // Host/user foreground permission; never a model-authored procedure field.
      allow_window_restore:z.boolean().default(false),
      // Separate permission: an already restored window may take foreground.
      allow_window_activation:z.boolean().default(false),
      value_encoding:z.enum(['exact','uia_single_line_document']).default('exact'),
    }).strict()).min(1).max(8),
  }).strict()).min(1).max(32),
}).strict();
export type WindowsDesktopCuaConfig=z.infer<typeof windowsDesktopCuaConfigSchema>;
export const windowsExecutorConfigSchema=z.discriminatedUnion('kind',[windowsCuaConfigSchema,windowsDesktopCuaConfigSchema]);
export type WindowsExecutorConfig=z.infer<typeof windowsExecutorConfigSchema>;
