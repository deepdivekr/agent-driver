export const browserSetupHtml=`<div id="browser-setup"><h3>브라우저 준비</h3><p class="muted keep">기본은 Playwright입니다. Aside·Neo는 원할 때만 연결하세요. 사이트 로그인은 업무에 필요할 때 안내합니다.</p><div id="browser-default"></div><details><summary>다른 브라우저 연결 · 선택</summary><p class="muted keep">설치 안내 → 앱에서 로그인·CLI 연결 → 연결 확인 → 등록 순서입니다. 연결한 브라우저의 화면을 사용하는 조회 작업에만 적용됩니다.</p><div id="browser-optional"></div><label><input id="browser-consent" type="checkbox"> 이 브라우저의 화면·로그인 프로필을 조회 작업에 사용하도록 연결합니다.</label><p class="muted keep">등록하면 새 MCP 연결부터 적용됩니다. 기존 연결은 다시 연결해야 하며, 진행 중 업무는 설정 변경 확인에서 멈출 수 있습니다.</p></details><p id="browser-setup-notice" class="muted keep" role="status"></p><button id="browser-setup-refresh">설치 안내 다시 불러오기</button></div>`;

export const browserSetupScript=`
let browserSetupState;
async function refreshBrowserSetup(){renderBrowserSetup(await request('settings/browsers'));}
function renderBrowserSetup(data){
  browserSetupState=data;$('browser-default').replaceChildren();$('browser-optional').replaceChildren();
  for(const row of data.rows){
    const card=document.createElement('div');card.className='client';card.dataset.browser=row.engine;
    const head=document.createElement('div');head.className='crow';const title=document.createElement('strong');title.textContent=row.label+(row.engine==='playwright'?' · 기본':' · 선택');
    const badge=document.createElement('span');badge.className='badge '+(row.health==='ready'?'ok':row.health==='unavailable'?'warn':'idle');badge.textContent=(row.health==='ready'?(row.engine==='playwright'?'설치 확인됨':'연결 확인됨'):row.reason==='cli_missing'?'CLI 설치 필요':row.health==='unavailable'?'설치·실행 확인 필요':'점검 전')+(row.registered?' · 등록됨':'');head.append(title,badge);card.append(head);
    for(const text of [row.setup,row.auth]){const p=document.createElement('p');p.className='muted keep';p.textContent=text;card.append(p);}
    const actions=document.createElement('div');actions.className='cact';
    for(const [label,url] of [['공식 설치 안내',row.docs],['연결·로그인 안내',row.connection]])if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noreferrer';link.textContent=label;actions.append(link);}
    const check=document.createElement('button');check.textContent=row.label+' 연결 확인';check.onclick=()=>action(async()=>{notice(row.label+' 확인 중…');const result=await request('settings/browsers/check',{engine:row.engine});renderBrowserSetup(result);notice('점검 결과를 표시했습니다. 실제 업무 성공 여부와 사이트 로그인은 별도로 확인합니다.');});actions.append(check);
    if(row.engine==='playwright'&&row.health==='unavailable'){const install=document.createElement('button');install.textContent='전용 브라우저 다운로드';install.onclick=()=>action(async()=>{notice('Chromium 다운로드 중…');renderBrowserSetup(await request('settings/browsers/install',{engine:'playwright'}));notice('브라우저 준비 결과를 확인하세요.');});actions.append(install);}
    if(row.engine!=='playwright'&&!row.registered&&row.health==='ready'){const register=document.createElement('button');register.textContent=row.label+' 연결 등록';register.onclick=()=>action(async()=>{if(!$('browser-consent').checked)throw Error('브라우저 화면·프로필 사용 동의를 확인하세요.');renderBrowserSetup(await request('settings/browsers/register',{engine:row.engine,revision:browserSetupState.revision,consent:true}));notice('연결을 등록했습니다. MCP를 다시 연결한 뒤 새 업무에서 사용하세요.');});actions.append(register);}
    card.append(actions);$(row.engine==='playwright'?'browser-default':'browser-optional').append(card);
  }
  $('browser-setup-notice').textContent=data.restart_required?'실행기 설정이 바뀌었습니다. MCP를 다시 연결하세요. 기존 업무의 승인·진행 상태는 유지됩니다.':'연결하지 않은 Aside·Neo 없이도 기본 Playwright 업무를 사용할 수 있습니다.';
}
$('browser-setup-refresh').onclick=()=>action(refreshBrowserSetup);
`;
