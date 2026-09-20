import {DatabaseSync} from 'node:sqlite';
import {createBackup,restoreBackup} from '../../dist/storage/backup.js';
const [mode,source,destination,point]=process.argv.slice(2);
if(mode==='writer'){
 const db=new DatabaseSync(source,{timeout:2000});db.exec('PRAGMA synchronous=FULL;');let writes=0;
 const timer=setInterval(()=>{db.prepare('INSERT INTO project VALUES (?,?)').run('writer-'+writes,JSON.stringify({id:'writer-'+writes}));writes++;process.send?.({writes});},5);
 process.on('message',m=>{if(m==='stop'){clearInterval(timer);db.close();process.send?.({done:true,writes});process.disconnect();}});
}else{
 const cut=p=>{if(p===point)process.kill(process.pid,'SIGKILL');};
 try{const result=mode==='backup'?await createBackup(source,destination,{rate:1,cut,onProgress:()=>cut('database_progress')}):await restoreBackup(source,destination,{cut});process.send?.({result});process.disconnect();}
 catch(error){process.send?.({error:error.message});process.exitCode=1;process.disconnect();}
}
