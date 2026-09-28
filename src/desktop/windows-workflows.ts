import {z} from 'zod';
import {type BasePackFamilyId} from '../taskpacks/base-pack-catalog.js';
import {type DesktopStepContract} from './work-procedure.js';

export type WindowsEffect='navigate'|'local_draft'|'local_write'|'external_send';
export interface WindowsWorkflowStep {
  id:string; goal:string; action:'invoke'|'replace_text';
  roles:readonly string[]; input?:string; requires:readonly string[];
  verifies:readonly string[]; effect:WindowsEffect;
  desktop?:DesktopStepContract;
}
export interface WindowsWorkflow {
  id:string; version:1; title:string; family:BasePackFamilyId; applications:readonly string[];
  example:string; inputs:Readonly<Record<string,string>>; steps:readonly WindowsWorkflowStep[];
  decision_inputs?:readonly string[];
  boundary:string; jev_value:string; completion:string; self_only:boolean;
}
const step=(id:string,goal:string,verifies:string[],effect:WindowsEffect='navigate',input?:string,requires:string[]=[]):WindowsWorkflowStep=>({
  id,goal,action:input?'replace_text':'invoke',roles:input?['edit','document']:['button','menu_item','list_item','tab_item'],
  ...(input?{input}:{}),requires,verifies,effect,
});

/** Profiles specialize existing families; they do not create ten new families or assert app coverage. */
export const WINDOWS_WORKFLOWS:readonly WindowsWorkflow[]=[
  {id:'windows.kakao.self-note',version:1,title:'카카오톡 나에게 보내기',family:'form.draft-submit',applications:['kakaotalk'],
    example:'카카오톡 내 프로필에서 나와의 채팅을 열고 이 메모를 보내줘.',inputs:{message:'자신에게 보낼 정확한 메시지'},self_only:true,
    steps:[step('profile','현재 로그인 계정의 내 프로필을 연다. 다른 친구 프로필은 선택하지 않는다.',['own_profile_visible']),step('self_chat','내 프로필의 나와의 채팅을 연다.',['self_chat_visible'],'navigate',undefined,['own_profile_visible']),step('draft','나와의 채팅 입력칸에 사용자 메시지만 입력한다.',['message_draft_matches'],'local_draft','message',['self_chat_visible']),step('send','동일한 나와의 채팅에 검증된 메시지를 한 번 보낸다.',['new_self_message_verified'],'external_send',undefined,['self_chat_visible','message_draft_matches'])],
    boundary:'수신자는 본인만. 친구·단체방·채널 전송 금지. 전송 직전 사용자 승인, 응답 유실 시 재전송 금지.',jev_value:'내 프로필·나와의 채팅·입력칸을 관측 후보에서 구분한다. 본인 여부와 전송 승인은 코드가 확인한다.',completion:'같은 자기 대화방에서 이번 전송의 새 메시지 ID와 본문 해시를 읽어 확인한다.'},
  {id:'windows.mail.draft',version:1,title:'메일 초안 작성',family:'form.draft-submit',applications:['outlook'],example:'Outlook에서 제목과 내용을 넣어 메일 초안만 만들어줘.',inputs:{subject:'메일 제목',body:'메일 본문'},self_only:false,
    steps:[step('compose','새 메일 작성 창을 연다.',['compose_visible']),step('subject','제목 입력칸을 채운다.',['subject_matches'],'local_draft','subject'),step('body','본문 편집 영역을 채운다.',['body_matches'],'local_draft','body',['subject_matches'])],boundary:'보내기·수신자 추가·첨부 업로드 없음. 초안 자동 동기화가 있는 앱은 host 승인이 필요하다.',jev_value:'제목·검색창·본문처럼 비슷한 입력 영역을 구분한다.',completion:'작성 창의 제목과 본문을 재관측하여 입력값 해시를 대조한다.'},
  {id:'windows.calendar.draft',version:1,title:'일정 초안 작성',family:'form.draft-submit',applications:['outlook'],example:'일정 제목·시간·설명을 입력하고 저장 전 보여줘.',inputs:{title:'일정 제목',start:'시작 일시와 시간대',end:'종료 일시와 시간대',description:'설명'},self_only:false,
    steps:[step('compose','새 일정 편집 창을 연다.',['event_editor_visible']),step('title','일정 제목을 입력한다.',['event_title_matches'],'local_draft','title'),step('start','시작 일시와 시간대를 입력한다.',['event_start_matches'],'local_draft','start'),step('end','종료 일시와 시간대를 입력한다.',['event_end_matches'],'local_draft','end'),step('description','일정 설명을 입력한다.',['event_draft_verified'],'local_draft','description',['event_title_matches','event_start_matches','event_end_matches'])],boundary:'저장·초대·발송 금지. 시간대와 종료 시각 검증 전 완료 아님.',jev_value:'시작·종료·종일·시간대 컨트롤을 구분한다.',completion:'제목·시간대 포함 시작/종료·설명이 요청과 일치하고 저장되지 않은 초안을 확인한다.'},
  {id:'windows.note.capture',version:1,title:'메모장에 메모 작성',family:'file.pipeline',applications:['notepad'],example:'메모장 새 문서에 이 내용을 옮겨줘.',inputs:{body:'메모 본문'},self_only:false,
    steps:[step('new','메모장에 새 빈 문서를 연다. 기존 문서는 닫거나 덮어쓰지 않는다.',['new_empty_document']),step('body','새 문서의 편집 영역에 내용을 입력한다.',['note_body_matches'],'local_draft','body',['new_empty_document'])],boundary:'기존 문서 덮어쓰기·파일 저장 없음.',jev_value:'메뉴 검색창과 실제 문서 편집 영역을 구분한다.',completion:'새 문서의 읽기 결과가 요청한 본문과 일치한다.'},
  {id:'windows.file.find-open',version:1,title:'파일 찾아 열기',family:'research.search',applications:['explorer'],example:'허용한 폴더에서 지정한 문서 파일을 찾아 열어줘.',inputs:{query:'찾을 파일명 또는 검색어'},self_only:false,
    decision_inputs:['query'],steps:[step('search','허용된 폴더의 검색칸에 검색어를 입력한다. 주소창에 명령을 입력하지 않는다.',['file_candidates_visible'],'navigate','query'),step('open','관측한 검색 결과에서 요청한 문서 파일 하나를 연다.',['requested_document_open'])],boundary:'host가 허용한 문서만. 실행파일·바로가기·스크립트 실행 및 자격증명 파일 접근 금지.',jev_value:'비슷한 이름의 문서 후보를 문맥과 관측 메타데이터로 구분한다.',completion:'열린 문서의 정확한 경로와 원본 파일 identity를 대조한다.'},
  {id:'windows.files.organize-preview',version:1,title:'파일 정리안 미리보기',family:'file.pipeline',applications:['explorer'],example:'허용한 바탕화면 파일을 살펴보고 정리안만 만들어줘.',inputs:{query:'분류 목적과 범위'},self_only:false,
    decision_inputs:['query'],steps:[step('inspect','허용된 폴더를 상세 보기로 관측한다. 파일 이동은 하지 않는다.',['folder_inventory_observed'])],boundary:'UI 관측 뒤 runtime_files_scan/classify/propose로 이어간다. 이 프로필은 이동하지 않으며 정리안 생성 자체는 기존 파일 도구가 맡는다.',jev_value:'관측된 문서 유형과 사용자 분류 목적이 맞는지 판단할 후보를 준비한다.',completion:'이 프로필의 완료는 폴더 관측까지. 전체 Work 완료에는 기존 파일 도구의 정리안과 사용자 검토가 필요하다.'},
  {id:'windows.sheet.filter-export',version:1,title:'엑셀 필터와 새 파일 저장',family:'file.pipeline',applications:['excel'],example:'열린 표에서 조건에 맞는 행만 골라 새 파일로 저장해줘.',inputs:{column:'필터를 적용할 정확한 열 이름',filter:'필터 조건',output:'승인된 새 출력 파일 경로'},decision_inputs:['column'],self_only:false,
    steps:[step('filter','요청한 열의 필터 편집기를 연다.',['filter_editor_visible']),step('condition','관측된 필터 입력칸에 조건을 넣는다.',['filter_matches'],'local_draft','filter'),step('export','필터 결과를 새 파일로 내보내는 대화창을 연다.',['export_dialog_visible'],'navigate',undefined,['filter_matches']),step('path','새 출력 경로를 입력한다.',['output_path_matches'],'local_draft','output'),step('save','원본을 보존하고 승인된 새 파일만 저장한다.',['export_file_verified'],'local_write',undefined,['output_path_matches','original_unchanged'])],boundary:'기존 파일 덮어쓰기 금지. 복합 필터가 단일 입력칸으로 표현되지 않으면 LLM 재계획.',jev_value:'요청한 열·필터 컨트롤·내보내기 메뉴를 고른다. 숫자 비교와 행 검증은 코드가 한다.',completion:'출력 파일 해시·필터·행 수를 독립 검증하고 원본 보존을 확인한다.'},
  {id:'windows.document.pdf',version:1,title:'문서를 PDF로 내보내기',family:'file.pipeline',applications:['word','libreoffice'],example:'열린 문서를 PDF로 새로 저장해줘. 원본은 그대로 둬.',inputs:{output:'승인된 새 PDF 경로'},self_only:false,
    steps:[step('export','PDF 내보내기 메뉴를 연다. 인쇄 발송은 선택하지 않는다.',['pdf_export_visible']),step('path','승인된 새 PDF 경로를 입력한다.',['pdf_path_matches'],'local_draft','output'),step('save','새 PDF를 저장한다.',['pdf_file_verified'],'local_write',undefined,['pdf_path_matches','original_unchanged'])],boundary:'기존 파일 덮어쓰기·온라인 전송·실물 인쇄 없음.',jev_value:'인쇄·공유·PDF 내보내기 메뉴 중 맞는 대상을 구분한다.',completion:'새 파일의 PDF signature·페이지 수·파일 해시와 원본 보존을 확인한다.'},
  {id:'windows.presentation.draft',version:1,title:'발표자료 수정 초안',family:'record.update',applications:['powerpoint'],example:'지정한 슬라이드의 텍스트만 바꿔줘. 저장은 하지 마.',inputs:{slide:'지정 슬라이드 번호 또는 제목',field:'지정 텍스트 상자 라벨',replacement:'교체할 정확한 텍스트'},decision_inputs:['slide','field'],self_only:false,
    steps:[step('select','요청한 슬라이드의 텍스트 상자 하나를 선택한다.',['slide_text_target_verified']),step('replace','선택한 텍스트 상자만 수정한다.',['slide_text_matches'],'local_draft','replacement',['slide_text_target_verified'])],boundary:'host가 확인한 로컬 사본만. 자동 저장 원본·다른 슬라이드 변경 금지.',jev_value:'슬라이드 본문·노트·제목 등 편집 대상을 구분한다.',completion:'슬라이드와 텍스트 상자 identity·변경 문자열·다른 영역 보존을 확인한다.'},
  {id:'windows.form.draft',version:1,title:'데스크톱 양식 입력',family:'form.draft-submit',applications:['host-registered'],example:'등록된 업무 앱에서 이 양식의 지정 입력칸을 채우고 제출 전에 멈춰줘.',inputs:{field:'지정 입력칸의 라벨과 양식 이름',value:'지정한 입력칸에 넣을 값'},decision_inputs:['field'],self_only:false,
    steps:[step('field','관측된 양식에서 요청한 입력칸을 채운다.',['form_field_matches'],'local_draft','value')],boundary:'비밀번호·인증·보안 설정 입력 금지. 자동 전송 필드 금지. 제출은 별도 승인 흐름.',jev_value:'라벨이 비슷한 필드 중 사용자 목적에 맞는 편집 대상을 고른다.',completion:'양식 identity와 지정 필드 값을 재확인하고 미제출 상태를 증명한다.'},
];

export function windowsWorkflow(id:string):WindowsWorkflow {
  const workflow=WINDOWS_WORKFLOWS.find(item=>item.id===id);
  if(!workflow)throw Error('WINDOWS_WORKFLOW_UNKNOWN');
  return workflow;
}
const ref=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
export const windowsTools={
  runtime_windows_catalog:{schema:z.object({}).strict(),implemented:true,readOnly:true},
  runtime_windows_plan:{schema:z.object({workflow_id:ref}).strict(),implemented:true,readOnly:true},
  runtime_windows_design:{schema:z.object({work_id:z.string().uuid(),refresh:z.boolean().default(false),observation:z.enum(['auto','visual']).default('auto')}).strict(),implemented:true,readOnly:false},
  runtime_windows_start:{schema:z.object({request_id:ref,work_id:z.string().uuid(),workflow_id:ref,inputs:z.record(z.string(),z.string().min(1).max(8000))}).strict(),implemented:true,readOnly:false},
  runtime_windows_step:{schema:z.object({run_id:z.string().uuid(),expected_revision:z.number().int().nonnegative()}).strict(),implemented:true,readOnly:false},
  runtime_windows_status:{schema:z.object({run_id:z.string().uuid()}).strict(),implemented:true,readOnly:true},
  runtime_windows_reconcile:{schema:z.object({run_id:z.string().uuid(),expected_revision:z.number().int().nonnegative()}).strict(),implemented:true,readOnly:false},
} as const;
