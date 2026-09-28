/** Per connection, never shared across client sampling or approval boundaries. */
export class McpLifetime {
  private accepting=true;
  private readonly pending=new Set<Promise<unknown>>();
  private closing:Promise<void>|null=null;
  get busy(){return this.pending.size>0;}
  constructor(private readonly hooks:{fence():void;disconnect():Promise<void>;dispose():Promise<void>}){}
  run<T>(operation:()=>Promise<T>):Promise<T>{
    if(!this.accepting)return Promise.reject(Error('MCP_CONNECTION_CLOSED'));
    // Admit synchronously so closing cannot omit a just-accepted operation.
    let promise:Promise<T>;
    try{promise=Promise.resolve(operation());}catch(error){promise=Promise.reject(error);}
    this.pending.add(promise);
    void promise.then(()=>this.pending.delete(promise),()=>this.pending.delete(promise));
    return promise;
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.accepting=false;
    // Defer callbacks until closing is assigned; transport.close re-enters onclose.
    this.closing=Promise.resolve().then(async()=>{
      try{this.hooks.fence();await this.hooks.disconnect();}
      finally{
        // Work planning and read-only tools also use the store. Do not close it
        // while only the Pack-specific drain thinks there are no pending calls.
        await Promise.allSettled([...this.pending]);
        await this.hooks.dispose();
      }
    });
    return this.closing;
  }
}
