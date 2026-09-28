// Node emits test:pass for skipped tests too. Never report an unavailable
// environment or an unexecuted assertion as a successful validation.
export function testOutcome(event){
  const data=event.data;
  if(data.skip||data.todo){
    const reason=String(data.skip||data.todo);
    return {status:reason.startsWith('BLOCKED_ENV:')?'BLOCKED_ENV':'NOT_RUN',reason};
  }
  return {status:event.type==='test:pass'?'PASS':'FAIL',reason:null};
}
