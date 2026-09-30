export const taskModelUiScript=`
function taskModelsHtml(d){
const plan=d.task_models;if(!plan)return '';const t=window.officeText,roles={planner:'계획',worker:'실행',verifier:'검증',synthesis:'종합'},clients={codex:'Codex',claude:'Claude Code',opencode:'OpenCode'},reasons={no_candidates:'구독 모델 후보를 확인할 수 없어 기본 모델을 유지합니다.',invalid_allocation:'배분 결과가 후보와 맞지 않아 기본 모델을 유지합니다.',allocation_unavailable:'자동 배분 응답을 받지 못해 기본 모델을 유지합니다.'};
return '<details id="task-model-allocation" data-work-id="'+esc(d.id)+'" class="runlist"><summary>'+esc(t('태스크 모델 배분'))+' · '+esc(t(plan.status==='assigned'?'Auto':'기본 모델 유지'))+'</summary><p class="muted">'+esc(t('저장된 배분 계획입니다. 실제 사용 모델과 인계는 실행 요약에서 확인하세요.'))+'</p>'+(plan.status==='fallback'?'<p>'+esc(t(reasons[plan.reason]||'자동 배분 응답을 받지 못해 기본 모델을 유지합니다.'))+'</p>':'')+'<ol>'+plan.assignments.map(item=>'<li><strong>'+esc(t(roles[item.role]||item.role))+'</strong> · <span data-i18n-skip>'+esc(item.client?(clients[item.client]||item.client)+' / '+item.model:t('앱별 기본 모델'))+'</span>'+(item.reason?'<p data-i18n-skip>'+esc(item.reason)+'</p>':'')+'</li>').join('')+'</ol><p class="muted">'+esc(t('사용하지 않는 역할은 별도 에이전트를 만들지 않습니다.'))+'</p></details>';
}
`;
