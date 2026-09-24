import readline from 'node:readline';

const first='11111111-1111-4111-8111-111111111111';
const second='22222222-2222-4222-8222-222222222222';
const foreign='33333333-3333-4333-8333-333333333333';
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
for await(const line of readline.createInterface({input:process.stdin})){
  const request=JSON.parse(line);
  if(request.method==='initialized')continue;
  if(request.method==='initialize'){
    send({id:request.id,result:{userAgent:'fake-test'}});
    continue;
  }
  if(request.method==='thread/list'){
    const params=request.params;
    if(params.cwd!==process.cwd()||JSON.stringify(params.sourceKinds)!=='["cli","exec"]'||params.archived!==false||params.limit!==50){
      send({id:request.id,error:{message:'unsafe discovery'}});continue;
    }
    send({method:'thread/status/changed',params:{threadId:first,status:{type:'idle'}}});
    send({id:request.id,result:params.cursor==='older'
      ?{data:[{id:second,cwd:process.cwd(),name:'Older CLI run',preview:'Continue review',status:{type:'active'},createdAt:3,updatedAt:4}],nextCursor:null}
      :{data:[{id:first,cwd:process.cwd(),name:'Feature work',preview:'Implement the feature',status:{type:'notLoaded'},createdAt:1,updatedAt:2},{id:foreign,cwd:'/other/project',name:'Private other work',preview:'Not visible',status:{type:'idle'}}],nextCursor:'older'}});
    continue;
  }
  if(request.method==='thread/read'){
    if(request.params.includeTurns!==false){send({id:request.id,error:{message:'turn content requested'}});continue;}
    send({id:request.id,result:{thread:{id:request.params.threadId,cwd:process.cwd(),name:'Feature work',preview:'Implement the feature',status:{type:'idle'},createdAt:1,updatedAt:5}}});
    continue;
  }
  send({id:request.id,error:{message:'unexpected method'}});
}
