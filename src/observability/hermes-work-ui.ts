export function hermesWorkScript(){return `
let hermesDraft='',hermesBusy=false,hermesRequestId=null,hermesCost=false;
const hermesLabels={ready:'지시 대기',queued:'실행 대기',starting:'Hermes 연결 중',running:'실행 중',needs_human:'확인 필요',paused:'일시정지',finished:'답변 도착',failed:'연결 또는 실행 실패',reconciliation_required:'중단 결과 확인 필요',detached:'가져오기 연결 해제'};
function renderHermesDetail(){
 const d=detail,h=d.hermes,def=d.definition,lastPlan=[...h.events].reverse().find(e=>e.kind==='plan');let steps=[];try{steps=lastPlan?JSON.parse(lastPlan.summary):[]}catch{}
 const state=d.run_status,title=hermesLabels[state]||state;
 app.innerHTML='<button type="button" class="back" id="back">← 업무 목록</button><section class="work-head"><span class="state">'+esc(title)+'</span><h2>'+esc(d.title)+'</h2><div class="reqbox"><span class="who">Hermes 실행 · Driver 관리</span><p class="request">'+esc(d.goal)+'</p></div><div class="checks-wrap"><details open><summary>완료 확인</summary><div class="checks">'+def.checks.map(v=>'<span class="check">'+esc(v)+'</span>').join('')+'</div></details></div></section>'+
 '<div class="layout"><section class="panel trace-panel"><h3>현재 진행</h3><p>'+esc(title)+'</p><p class="muted">'+(h.session_id?'Hermes 세션 '+esc(h.session_id):'첫 지시를 보낼 때 전용 Hermes 세션을 만듭니다.')+'</p>'+
 (steps.length?'<ol>'+steps.map(s=>'<li>'+esc(s.step)+' · '+esc(s.status)+'</li>').join('')+'</ol>':'<p class="muted">아직 Hermes가 보고한 실행 단계가 없습니다.</p>')+
 '<details><summary>업무 절차</summary><ol>'+def.steps.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ol></details><p class="pack">Pack · '+esc(def.family)+'</p><details><summary>가져온 기록</summary>'+def.history.map(v=>'<p>'+esc(v.summary)+'<br><small class="muted">'+esc(v.source)+'</small></p>').join('')+'</details><h3>실제 작업 로그</h3><div role="log" aria-label="Hermes 작업 로그">'+h.events.slice(-20).map(e=>'<p class="coding-meta">'+esc(e.created_at)+'<br>'+esc(e.summary)+'</p>').join('')+'</div></section>'+
 '<section class="panel control-panel"><h3>업무 제어</h3><div class="controls"><button type="button" data-hermes-action="'+(h.paused?'resume':'pause')+'">'+(h.paused?'배정 재개':'일시정지')+'</button>'+(h.needs_review?'<button type="button" data-hermes-action="review">결과 확인 · 다음 지시 준비</button>':'')+'</div><p class="control-note">일시정지는 새 배정을 막고 진행 중인 요청에 중단을 전달합니다. 이미 발생한 변경은 취소되지 않습니다. 재개해도 중단된 지시를 자동 반복하지 않습니다.</p>'+
 (h.permission?'<article class="coding-reconcile"><h4>Hermes 승인 요청</h4><pre style="white-space:pre-wrap">'+esc(h.permission.title)+'</pre><small>현재 요청 한 번에만 적용됩니다.</small><div class="controls">'+h.permission.options.map(o=>'<button type="button" data-hermes-option="'+esc(o.id)+'">'+esc(o.label)+'</button>').join('')+'</div></article>':'')+
 '<div class="editor"><label for="hermes-instruction">Hermes에 다음 지시</label><textarea id="hermes-instruction" maxlength="4000" placeholder="대상 날짜와 원하는 결과를 알려주세요. 제출·전송은 필요할 때 명시해 주세요.">'+esc(hermesDraft)+'</textarea><label><input id="hermes-cost" type="checkbox"> Hermes에 설정된 모델로 실행합니다. 설정에 따라 API 비용 또는 구독 사용량이 발생합니다.</label><button type="button" id="hermes-send" class="primary" '+(h.can_send&&!hermesBusy?'':'disabled')+'>Hermes로 실행</button></div><p class="muted">Hermes의 모델·인증 설정을 유지합니다. 이 버튼은 자동 예약을 만들지 않습니다. Telegram 게이트웨이는 그대로 유지됩니다.</p>'+
 h.turns.map(t=>'<article class="coding-turn"><h4>'+esc(hermesLabels[t.status]||t.status)+'</h4><pre style="white-space:pre-wrap">'+esc(t.instruction)+'</pre>'+(t.reply?'<div class="coding-answer"><b>Hermes 답변 · 결과 확인 필요</b><pre>'+esc(t.reply)+'</pre></div>':'')+(t.reason?'<small class="muted">'+esc(t.reason)+'</small>':'')+'</article>').join('')+'</section></div>';
 document.getElementById('back').onclick=showBoard;
 if(d.migration){const link=document.createElement('a');link.href='?import=1&migration_id='+encodeURIComponent(d.migration.id);link.textContent='이전 기록 · 첫 실행 전 연결 취소';app.querySelector('.work-head').append(link)}
 if(h.detached)app.querySelectorAll('[data-hermes-action],#hermes-send,#hermes-instruction,#hermes-cost').forEach(node=>{node.disabled=true});
 app.querySelectorAll('[data-hermes-action]').forEach(b=>b.onclick=()=>hermesAction(b.dataset.hermesAction));
 app.querySelectorAll('[data-hermes-option]').forEach(b=>b.onclick=()=>hermesAction('permission',{permission_id:h.permission.id,option_id:b.dataset.hermesOption}));
 document.getElementById('hermes-instruction').oninput=e=>{hermesDraft=e.target.value;hermesRequestId=null};
 document.getElementById('hermes-cost').checked=hermesCost;
 document.getElementById('hermes-cost').onchange=e=>{hermesCost=e.target.checked};
 document.getElementById('hermes-send').onclick=()=>{const input=document.getElementById('hermes-instruction').value.trim();if(input.length<3){setMessage('이번에 실행할 지시를 입력해 주세요.');return}if(!document.getElementById('hermes-cost').checked){setMessage('Hermes 모델 사용량 안내를 확인해 주세요.');return}hermesRequestId??=crypto.randomUUID();hermesAction('send',{request_id:hermesRequestId,instruction:input,cost_acknowledged:true})};
}
async function hermesAction(action,extra={}){
 if(hermesBusy||!detail?.hermes)return;const target=detail.id;hermesBusy=true;setMessage('요청을 저장하는 중…');
 try{const response=await fetch('work/hermes/action',{method:'POST',headers:{'content-type':'application/json','x-agent-driver':'human-office'},body:JSON.stringify({work_id:target,revision:detail.revision,action,...extra})}),data=await response.json();if(!response.ok)throw Error(data.error||'Hermes 요청 실패');if(selected!==target)return;if(action==='send'){hermesDraft='';hermesRequestId=null;hermesCost=false}detail=data;renderHermesDetail();setMessage(action==='send'?'지시를 접수했습니다. Hermes의 진행과 답변이 여기에 표시됩니다.':action==='review'?'새 지시를 보낼 수 있습니다. 자동 재실행은 하지 않습니다.':'요청을 반영했습니다.')}
 catch(error){await loadDetail();setMessage(String(error.message||error))}finally{hermesBusy=false;if(detail?.hermes&&document.activeElement?.id!=='hermes-instruction')renderHermesDetail()}
}
`;}
