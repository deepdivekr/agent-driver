/** Shared Control Center chrome in the agent-driver storyboard language: dark ground, mono-first labels, amber cursor accent,
 * one color per decision path (jev amber, llm lilac, code blue, human rose, verified green). No framework, web fonts or images. */
export const uiCss=`:root{color-scheme:dark;--bg:#101317;--side:#101317;--panel:#171b21;--raise:#1d222a;--line:#262c35;--line2:#343b46;--text:#e6e8eb;--dim:#8b93a0;--faint:#4a515c;--accent:#F5A524;--accent-ink:#16120a;--ok:#6CC08B;--warn:#E0708A;--err:#ef5b5b;--run:#F5A524;--idle:#7c8491;--llm:#A99BE0;--code:#6FA8DC;--human:#E0708A;--acc-a:rgba(245,165,36,.12);--human-a:rgba(224,112,138,.12);--ok-a:rgba(108,192,139,.12);--r:10px;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,"DejaVu Sans Mono",Menlo,Consolas,monospace;--sans:"IBM Plex Sans","IBM Plex Sans KR",system-ui,-apple-system,"Segoe UI","Noto Sans KR",sans-serif;font:14px/1.5 var(--sans);color:var(--text);background:var(--bg)}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f5f7;--side:#f4f5f7;--panel:#fff;--raise:#eef0f3;--line:#e2e5ea;--line2:#cfd4db;--text:#171a1f;--dim:#5f6774;--faint:#a3aab4;--accent:#c77d05;--accent-ink:#fff;--ok:#2f8f55;--warn:#c2415f;--err:#c73a3a;--run:#c77d05;--idle:#7c8491;--llm:#6f5bc4;--code:#2f6fae;--human:#c2415f;--acc-a:rgba(199,125,5,.10);--human-a:rgba(194,65,95,.10);--ok-a:rgba(47,143,85,.10)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg)}[hidden]{display:none!important}a{color:var(--accent)}
button,select,input,textarea{font:inherit;color:inherit;background:var(--raise);border:1px solid var(--line2);border-radius:8px;padding:6px 11px;max-width:100%}
button{cursor:pointer;white-space:nowrap;font-family:var(--mono);font-size:12.5px}button:hover{border-color:var(--dim)}button:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}button.warning{border-color:var(--human);color:var(--human);background:var(--human-a)}
input,select,textarea{width:100%;background:var(--bg)}input[type=checkbox],input[type=radio]{width:auto;accent-color:var(--accent);margin:0 6px 0 0;vertical-align:-2px}textarea{min-height:84px;resize:vertical}
label{display:block;margin:12px 0 4px;color:var(--dim);font-size:13px}h1,h2,h3,h4,h5{margin:0;font-weight:600;letter-spacing:-.01em;text-wrap:balance}h1{font:600 20px var(--sans)}h2{font-size:17px}h3{font:600 14px var(--mono)}h4{font:600 13px var(--mono)}
.muted,small{color:var(--dim)}small{font-size:12px}code,pre{font:12px/1.55 var(--mono)}.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.lbl{font:500 10.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.app{display:grid;grid-template-columns:224px minmax(0,1fr);min-height:100vh;background:linear-gradient(to right,var(--side) 223px,var(--line) 223px 224px,var(--bg) 224px)}
.side{background:var(--side);padding:22px 14px;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{display:flex;align-items:center;gap:3px;font:600 19px var(--mono);letter-spacing:-.02em;padding:0 6px}.brand i{display:inline-block;width:8px;height:19px;background:var(--accent)}
@media(prefers-reduced-motion:no-preference){.brand i,.caret{animation:ao-blink 1.1s steps(1) infinite}}@keyframes ao-blink{50%{opacity:0}}
.brand-sub{font:11.5px var(--mono);color:var(--dim);padding:4px 6px 12px}
.side .sec{font:500 10.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);padding:14px 8px 6px}
.nav{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border:0;background:none;border-radius:7px;padding:7px 8px;color:var(--dim);text-decoration:none;text-align:left;font:13.5px var(--sans)}
.nav:hover{background:var(--panel);color:var(--text)}.nav[aria-current=page],.nav.on{background:var(--panel);color:var(--text);box-shadow:inset 3px 0 0 var(--accent)}.nav .n{font:12px var(--mono);color:var(--faint)}.nav .n.warn{color:var(--human)}
.paths{display:flex;gap:4px;flex-wrap:wrap;padding:2px 8px}
.pth{font:10.5px var(--mono);border-radius:4px;padding:1px 6px}.p-code{color:var(--code);background:rgba(111,168,220,.12)}.p-jev{color:var(--accent);background:var(--acc-a)}.p-llm{color:var(--llm);background:rgba(169,155,224,.12)}.p-human{color:var(--human);background:var(--human-a)}
.side .foot{margin-top:auto;padding:12px 8px 0;font:11px var(--mono);color:var(--faint);border-top:1px solid var(--line)}
.main{min-width:0;padding:24px 30px 44px}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}.top h1{margin-right:auto}
.lang{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;font:500 11.5px var(--mono);letter-spacing:.06em}
.lang svg{width:20px;height:14px;border-radius:2px;box-shadow:0 0 0 1px var(--line2);flex:none}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px}
.badge{display:inline-flex;align-items:center;gap:5px;font:500 11.5px var(--mono);line-height:1;padding:4px 9px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.ok{color:var(--ok)}.warn{color:var(--human)}.err{color:var(--err)}.run{color:var(--run)}.idle{color:var(--idle)}.badge.idle{border-style:dashed}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;display:inline-block;flex:none}
.caret{display:inline-block;width:8px;height:16px;background:var(--accent);vertical-align:-3px;flex:none}
.import-routes .hint{align-self:center}.hint{width:20px;height:20px;padding:0;border-radius:50%;font-size:12px;line-height:18px;color:var(--faint);background:none;margin-left:6px;vertical-align:1px}
.hinted{display:none}:is(h1,h2,h3,h4,h5,label):has(+.hint){display:inline-block}
dialog.help{border:1px solid var(--line2);border-radius:12px;background:var(--panel);color:var(--text);max-width:min(520px,calc(100vw - 32px));padding:18px}dialog.help::backdrop{background:#0009}
dialog.help p{margin:0 0 14px;line-height:1.6;white-space:pre-line}dialog.help form{text-align:right}
.notice{min-height:20px;margin:10px 0;color:var(--accent);font:12.5px var(--mono);overflow-wrap:anywhere}
.tagline{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);display:flex;gap:14px;flex-wrap:wrap;font:11.5px var(--mono);color:var(--faint)}.tagline span:last-child{margin-left:auto}
@media(max-width:760px){.app{grid-template-columns:1fr;grid-template-rows:auto 1fr;background:var(--bg)}.side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:4px;padding:12px 16px;border-bottom:1px solid var(--line)}.brand{width:100%;padding:0 0 6px}.brand-sub,.side .sec,.side .foot,.paths{display:none}.nav{width:auto;padding:5px 8px}.main{padding:16px 16px 36px}}`;

export type ShellPage='work'|'settings'|'connections';
/** Sidebar links are plain anchors so every view is one click away and pages stay independent. */
export function sidebarHtml(page:ShellPage){
  const current=(value:ShellPage)=>page===value?' aria-current="page"':'';
  return `<aside class="side" aria-label="메뉴"><div class="brand">agent-office<i aria-hidden="true"></i></div><div class="brand-sub">local mcp · stdio</div>
<div class="sec">work</div>
<a class="nav" href="./?view=all" data-view="all">전체<span class="n" data-count="all"></span></a>
<a class="nav" href="./?view=attention" data-view="attention">확인 필요<span class="n warn" data-count="attention"></span></a>
<a class="nav" href="./?view=active" data-view="active">진행 중<span class="n" data-count="active"></span></a>
<a class="nav" href="./?view=waiting" data-view="waiting">대기<span class="n" data-count="waiting"></span></a>
<a class="nav" href="./?view=done" data-view="done">종료된 업무<span class="n" data-count="done"></span></a>
<div class="sec">tools</div>
<a class="nav" href="./?import=1" data-nav="import">가져오기</a>
<a class="nav" id="connections" href="connections"${current('connections')}>사이트 로그인</a>
<a class="nav" href="settings"${current('settings')}>연결 및 설정</a>
<div class="sec">decision plane</div><div class="paths"><span class="pth p-code">code</span><span class="pth p-jev">jev</span><span class="pth p-llm">llm</span><span class="pth p-human">human</span></div>
<div class="foot" id="shell-foot">127.0.0.1 · no cloud relay</div></aside>`;
}
const usFlag='<svg viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><path d="M0 1h20M0 3.2h20M0 5.4h20M0 7.6h20M0 9.8h20M0 12h20" stroke="#b22234" stroke-width="1.1"/><rect width="8.6" height="7.6" fill="#3c3b6e"/></svg>';
const krFlag='<svg viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" fill="#fff"/><circle cx="10" cy="7" r="3" fill="#0047a0"/><path d="M7 7a3 3 0 0 1 6 0a1.5 1.5 0 0 1-3 0a1.5 1.5 0 0 0-3 0z" fill="#cd2e3a"/><g stroke="#000" stroke-width=".7"><path d="M3.2 3.4l1.6-1.1M3.6 4l1.6-1.1M4 4.6l1.6-1.1M14.4 11.5l1.6-1.1M14.8 12.1l1.6-1.1M15.2 12.7l1.6-1.1M14.4 2.5l1.6 1.1M14 3.1l1.6 1.1M3.2 10.6l1.6 1.1M3.6 10l1.6 1.1"/></g></svg>';
/** One flag button per page header. English is the default; the choice is remembered per browser only. */
export const langButtonHtml=`<button type="button" class="lang" id="lang-toggle" data-i18n-skip aria-label="Language: English. Switch to Korean"><span data-lang-flag>${usFlag}</span><span data-lang-code>EN</span></button>`;
/** Long explanations become a "?" button that opens one shared dialog; the text stays in the DOM for assistive tech and search. */
export const helpDialogHtml=`<dialog class="help" id="help"><p id="help-text"></p><form method="dialog"><button class="primary">닫기</button></form></dialog>`;
export const helpScript=`function compactHints(root,min=48){for(const node of root.querySelectorAll('p.muted:not(.keep),small.explain')){if(node.dataset.hinted||node.textContent.trim().length<min)continue;node.dataset.hinted='1';node.classList.add('hinted');const button=document.createElement('button');button.type='button';button.className='hint';button.textContent='?';button.title='설명';button.setAttribute('aria-label','설명 보기');button.onclick=()=>{document.getElementById('help-text').textContent=node.textContent;document.getElementById('help').showModal()};const host=node.previousElementSibling&&/^(H[1-5]|LABEL)$/.test(node.previousElementSibling.tagName)?node.previousElementSibling:null;const group=node.previousElementSibling?.getAttribute('role')==='group'?node.previousElementSibling:null;if(host)host.after(button);else if(group)group.append(button);else node.before(button)}}`;
export const flagSvgs={us:usFlag,kr:krFlag};
