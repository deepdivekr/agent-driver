import {type DatabaseSync} from 'node:sqlite';
import {requireCondition} from '../core/contracts.js';
import {NativeFieldDriver,type NativeFieldScope} from './native-field-driver.js';
/** Compatibility port for explicitly injected window2 hosts. Not the built-in executor. */
export interface Window2Window {id:number;app:string;title?:string;}
export interface Window2State {window:Window2Window;accessibility:{tree:string;focused_element?:string;document_text?:string;}|null;}
export interface Window2Client {
  list_windows():Promise<Window2Window[]>;
  get_window_state(input:{window:Window2Window;include_text:true;include_screenshot:false}):Promise<Window2State>;
  set_value(input:{window:Window2Window;element_index:number;value:string}):Promise<void>;
}
export type Window2FieldScope=NativeFieldScope;
interface Field {index:number;automation_id:string;label:string;value:string;enabled:boolean;line:string;}
/** Deliberately narrow parser for the documented window2 editable-value format.
 * Unknown formats, missing values, duplicate identities and multi-line fields
 * fail closed. Raw values/trees never enter the model's observation. */
export function readWindow2Editable(tree:string,automationId:string,label:string):Field {
  requireCondition(Buffer.byteLength(tree)<=128_000,'WINDOW2_TREE_TOO_LARGE');
  const matches:Field[]=[];
  for(const line of tree.split(/\r?\n/u)){
    const item=/^\s*(\d+)\s+(?:Edit|편집)\s+\(([^)]*)\)\s+(.+?)\s+Value: (.*?)\s+ID: ([^\r\n]+)$/iu.exec(line);
    if(!item||item[5]!==automationId||item[3]!==label)continue;
    const flags=item[2]!.split(',').map(s=>s.trim().toLowerCase());
    requireCondition(flags.includes('settable')&&flags.includes('string'),'WINDOW2_FIELD_NOT_SETTABLE');
    requireCondition(flags.every(flag=>['settable','string','disabled','focused'].includes(flag)),'WINDOW2_FIELD_STATE_UNKNOWN');
    requireCondition(item[4]!.length<=8_000,'WINDOW2_VALUE_TOO_LARGE');
    matches.push({index:Number(item[1]),automation_id:item[5]!,label:item[3]!,value:item[4]!,enabled:!flags.includes('disabled'),line:line.trim()});
  }
  requireCondition(matches.length===1,'WINDOW2_FIELD_NOT_UNIQUE');return matches[0]!;
}


export class Window2FieldDriver extends NativeFieldDriver {
  constructor(client:Window2Client,db:DatabaseSync,id:string){
    super({
      async readField(scope){
        const windows=(await client.list_windows()).filter(w=>w.id===scope.window.id&&w.app===scope.window.app);
        requireCondition(windows.length===1&&windows[0]!.title===scope.window_title,'WINDOW2_WINDOW_BINDING_CHANGED');
        const state=await client.get_window_state({window:windows[0]!,include_text:true,include_screenshot:false});
        requireCondition(state.accessibility!==null,'WINDOW2_ACCESSIBILITY_UNAVAILABLE');
        const field=readWindow2Editable(state.accessibility.tree,scope.automation_id,scope.label);
        return {window:state.window,field:{...field,visible:true},focus:state.accessibility.focused_element??null};
      },
      async setValue(state,value){await client.set_value({window:state.window,element_index:state.field.index,value});}
    },db,id);
  }
}
