import {requireCondition} from '../core/contracts.js';
import {createBackup,inspectBundle,restoreBackup,checkpointDatabase} from './backup.js';

export const maintenanceHelp=`
Operator-only maintenance (Linux; private data; never automatic execution):
  maintenance backup --db PATH --destination NEW_DIRECTORY [--max-bytes N]
  maintenance inspect --backup DIRECTORY [--expected-sha256 DIGEST]
  maintenance restore --backup DIRECTORY --destination NEW_DIRECTORY [--expected-sha256 DIGEST]
  maintenance checkpoint --db PATH
Restores are quarantined, not runnable. User worktrees, authentication and browser
profiles are not restored. Checkpoint is PASSIVE, never an automatic WAL truncate.
`;
export async function runMaintenanceCli(args:string[]):Promise<boolean> {
 if(args[0]!=='maintenance')return false;
 const command=args[1],options=new Map<string,string>();
 requireCondition(command&&['backup','inspect','restore','checkpoint'].includes(command),'UNKNOWN_COMMAND');
 const allowed=command==='backup'?['--db','--destination','--max-bytes']:command==='restore'?['--backup','--destination','--expected-sha256']:command==='inspect'?['--backup','--expected-sha256']:['--db'];
 for(let i=2;i<args.length;i+=2){const key=args[i]!,value=args[i+1];requireCondition(allowed.includes(key)&&!options.has(key)&&value&&!value.startsWith('--'),'INVALID_OPTIONS');options.set(key,value);}
 const get=(key:string)=>{const value=options.get(key);requireCondition(value,'MISSING_OPTION');return value;};
 const digest=options.get('--expected-sha256');if(digest!==undefined)requireCondition(/^[a-f0-9]{64}$/.test(digest),'BACKUP_INVALID_DIGEST');
 let result:unknown;
 if(command==='backup')result=await createBackup(get('--db'),get('--destination'),options.has('--max-bytes')?{maxBytes:Number(get('--max-bytes'))}:{});
 else if(command==='inspect')result=inspectBundle(get('--backup'),digest);
 else if(command==='restore')result=await restoreBackup(get('--backup'),get('--destination'),digest?{expectedHash:digest}:{});
 else result=checkpointDatabase(get('--db'));
 console.log(JSON.stringify(result));return true;
}
