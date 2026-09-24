import {z} from 'zod';

/**
 * These are user-facing workflow families, not an MCP adapter registry.
 * A concrete Pack narrows one family to reviewed inputs, sources, routes and
 * verification.  Users may begin with a one-line request; the runtime never
 * gives an inferred family execution authority by itself.
 */
export const basePackFamilyId=z.enum([
  'research.search',
  'portal.collect',
  'form.draft-submit',
  'record.update',
  'inbox.triage',
  'monitor.watch',
  'file.pipeline',
  'choose.stage',
  'coding.orchestrate',
]);
export type BasePackFamilyId=z.infer<typeof basePackFamilyId>;

export const basePackFamily=z.object({
  id:basePackFamilyId,
  title:z.string().min(1).max(80),
  user_goal:z.string().min(1).max(240),
  effect:z.enum(['read_only','local_file_write','external_write_staged']),
  approval:z.enum(['none','before_external_effect','never_external_effect']),
  required_nodes:z.array(z.enum(['observe','discover','collect','extract','normalize','draft','verify','approve','commit','reconcile','notify'])).min(1),
  default_boundary:z.string().min(1).max(240),
}).strict();
export type BasePackFamily=z.infer<typeof basePackFamily>;

export const BASE_PACK_CATALOG:readonly BasePackFamily[]=[
  {id:'research.search',title:'찾기와 비교',user_goal:'여러 출처에서 조건에 맞는 정보를 찾고 근거와 미확인 사항을 함께 받는다.',effect:'read_only',approval:'never_external_effect',required_nodes:['observe','discover','collect','extract','verify'],default_boundary:'검색 결과를 읽고 정리한다. 로그인·메시지·구매·저장은 하지 않는다.'},
  {id:'portal.collect',title:'조회와 내려받기',user_goal:'로그인된 포털이나 사내 도구에서 필요한 기간·필터의 데이터를 수집한다.',effect:'local_file_write',approval:'never_external_effect',required_nodes:['observe','collect','extract','normalize','verify'],default_boundary:'서버 상태를 바꾸지 않고, 내려받은 파일은 hash와 내용으로 검증한다.'},
  {id:'form.draft-submit',title:'양식 초안과 제출',user_goal:'새 양식을 채우고 사용자 확인 뒤 정확히 한 번 제출한다.',effect:'external_write_staged',approval:'before_external_effect',required_nodes:['observe','draft','verify','approve','commit','reconcile'],default_boundary:'초안·pre-submit capture·task-bound 승인이 모두 있어야 제출한다. 응답 유실은 재조회한다.'},
  {id:'record.update',title:'기존 기록 수정',user_goal:'기존 티켓·업무 기록을 찾아 정해진 필드만 수정하고 재조회한다.',effect:'external_write_staged',approval:'before_external_effect',required_nodes:['observe','extract','draft','verify','approve','commit','reconcile'],default_boundary:'대상 identity와 수정 전후 값을 확인하며, 관련 없는 필드는 보존한다.'},
  {id:'inbox.triage',title:'받은 일 분류',user_goal:'메일·문의·티켓을 분류하고 요약·담당자·답변 초안을 만든다.',effect:'read_only',approval:'never_external_effect',required_nodes:['observe','collect','extract','normalize','verify'],default_boundary:'기본 결과는 분류와 초안이다. 외부 전송은 별도 승인형 Pack이다.'},
  {id:'monitor.watch',title:'변화 감시',user_goal:'정해진 소스의 변화를 주기적으로 확인하고 근거와 함께 알린다.',effect:'read_only',approval:'never_external_effect',required_nodes:['observe','collect','verify','notify'],default_boundary:'변화 여부를 관측하고 알릴 뿐, 후속 외부 행동을 자동으로 시작하지 않는다.'},
  {id:'file.pipeline',title:'파일 정리와 검증',user_goal:'파일을 수집·병합·변환·검증해 다음 작업에 쓸 결과물을 만든다.',effect:'local_file_write',approval:'never_external_effect',required_nodes:['collect','extract','normalize','verify'],default_boundary:'새 결과물은 별도 위치에 만들고 원본은 보존한다. 외부 업로드는 별도 승인형 Pack이다.'},
  {id:'choose.stage',title:'비교와 준비',user_goal:'상품·예약·공급업체 후보를 비교하고 장바구니나 요청 초안까지 준비한다.',effect:'external_write_staged',approval:'before_external_effect',required_nodes:['observe','discover','collect','extract','verify','approve','commit','reconcile'],default_boundary:'구매·결제·예약 확정은 포함하지 않는다. stage 결과도 대상·가격·계정 재확인이 필요하다.'},
  {id:'coding.orchestrate',title:'코딩 업무 지휘',user_goal:'등록한 프로젝트에서 코딩 CLI의 구현·검토·문서 작업을 단계별로 인계한다.',effect:'local_file_write',approval:'none',required_nodes:['observe','draft','verify','reconcile'],default_boundary:'프로젝트별 허용 범위와 정확한 CLI 세션만 사용한다. 결과 문구만으로 완료·커밋·배포를 판정하지 않는다.'},
] as const;

export function basePackFamilyById(id:string):BasePackFamily|undefined {
  return BASE_PACK_CATALOG.find(family=>family.id===id);
}
