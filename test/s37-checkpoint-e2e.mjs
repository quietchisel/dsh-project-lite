/**
 * test/s37-checkpoint-e2e.mjs —— Continuity 0.1：工具 + 路由端到端闭环。
 * E1 propose_checkpoint 工具注册且成功提交（身份来自 exec）
 * E2 伪造 source_session_id 被忽略（身份只来自 exec）
 * E3 checkpoints 列表路由返回待确认项 + 来源会话标题
 * E4 确认路由 proposed→confirmed
 * E5 拒绝路由 proposed→rejected
 * E6 resume() 读到 latest_confirmed_checkpoint
 * E7 确认路由幂等（重复请求不重复写）
 * 用法：node test/s37-checkpoint-e2e.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const BASE=process.argv[2], OUT=process.argv[3]
const steps=[]; const push=(id,ok,d)=>{steps.push({id,ok:!!ok,detail:d});console.log((ok?'PASS ':'FAIL ')+id+' :: '+d)}
const INST='D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1'
const M=await import(pathToFileURL(INST+'/index.js').href)
const {registerAgentTools}=await import(pathToFileURL(INST+'/core/agent-tools.mjs').href)
const {createReadService}=await import(pathToFileURL(INST+'/core/read.mjs').href)
const {openStore}=await import(pathToFileURL(INST+'/core/store.mjs').href)
await rm(BASE,{recursive:true,force:true}); const ROOT=join(BASE,'store'); await mkdir(ROOT,{recursive:true})
const SID='session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', WS='ws-ffffffff-0000-0000-0000-000000000009'
await writeFile(join(ROOT,'workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{initialized:true,defaultWorkspaceId:WS,workspaceIds:[WS],archivedSessionIds:[],pinnedSessionIds:[]},tables:{workspaces:{[WS]:{path:BASE,title:'W',sessionIds:[SID],createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z'}}}}),'utf8')
// 注册路由
const routes=new Map(); const ctx={webServer:{register(d){routes.set(d.path,d);return()=>routes.delete(d.path)}},effect(){},storageDomain:undefined,get(){return null}}
M.apply(ctx,{root:ROOT,evidencePath:join(BASE,'ev.jsonl')})
// 注册工具
const reg=new Map(); const toolCtx={tools:{register(s){reg.set(s.name,s);return()=>{}}}}
const store=await openStore({root:ROOT,actor:'s37'})
registerAgentTools(toolCtx,{defineTool:(o)=>o,tools:toolCtx.tools,getStore:async()=>store,readService:createReadService,evidence:()=>{}})
await new Promise(r=>setTimeout(r,80))
const resume=reg.get('project_resume'), propose=reg.get('propose_checkpoint')
const exec={agent:{sessionId:SID}}
// 建项目（带 session_id 建 primary）
const {runAsCaller}=await import(pathToFileURL(INST+'/core/identity.mjs').href)
const p=await runAsCaller({sessionId:SID,source:'s37'},()=>store.createProject({name:'闭环项目',objective:'验证跨会话闭环',next_action:'完成检查点确认后恢复',session_id:SID}))
const pid=p.project.id
// E1 propose 工具
const cp=await propose.execute({project_id:pid,summary:'会话A完成了 Resume 与 Checkpoint 实现',completed:['resume()','propose_checkpoint'],next_action:'面板确认检查点',requestId:'s37_cp_001'},exec)
push('E1',cp.ok&&cp.checkpoint&&cp.checkpoint.status==='proposed','propose_checkpoint 工具成功提交 proposed')
// E2 伪造身份被忽略
const cpforge=await propose.execute({project_id:pid,summary:'伪造来源测试',source_session_id:'session-FAKE',requestId:'s37_cp_002'},exec)
push('E2',cpforge.ok&&cpforge.checkpoint.source_session_id===SID,'伪造 source_session_id 被忽略，身份取自 exec')
// E3 列表路由（含标题）
function reqRes(){return{}}
async function call(path,{method='GET',query='',json}={}){ const def=routes.get(path); const url='http://x'+path+(query?'?'+query:''); const raw=json===undefined?undefined:JSON.stringify(json); const chunks=raw?[Buffer.from(raw)]:[]; const req={method,url,headers:raw?{'content-type':'application/json'}:{},socket:{remoteAddress:'127.0.0.1'},async*[Symbol.asyncIterator](){for(const c of chunks)yield c}}; const out={statusCode:200,body:''}; const res={out,get statusCode(){return out.statusCode},set statusCode(v){out.statusCode=v},setHeader(){},end(c){if(c!=null)out.body+=String(c)}}; await def.handler(req,res); let b=null; try{b=out.body?JSON.parse(out.body):null}catch{}; return{status:out.statusCode,body:b} }
const list=await call(M.CHECKPOINTS_PATH,{query:'project_id='+pid})
push('E3',list.status===200&&list.body.total===2&&list.body.checkpoints.some(c=>c.status==='proposed'),'checkpoints 列表返回 2 条待/已确认项')
// E4 确认路由
const cf=await call(M.CONFIRM_CHECKPOINT_PATH,{method:'POST',json:{id:cp.checkpoint.id,requestId:'s37_cf_001'}})
push('E4',cf.status===200&&cf.body.checkpoint.status==='confirmed'&&!!cf.body.checkpoint.confirmed_at,'确认路由 proposed→confirmed')
// E6 resume 读到最新 confirmed（用新 store 实例读磁盘，验证重启后仍可读 + 跨会话接续）
const store2=await openStore({root:ROOT,actor:'s37-resume-next-session'})
const rr=await createReadService(store2).resume(pid,{checkpoints:store2.checkpoints()})
push('E6',rr.latest_confirmed_checkpoint&&rr.latest_confirmed_checkpoint.id===cp.checkpoint.id,'新会话 resume 从磁盘读到已确认 checkpoint（跨会话接续）')
await store2.close()
// E5 拒绝路由（拒绝伪造那条）
const rj=await call(M.REJECT_CHECKPOINT_PATH,{method:'POST',json:{id:cpforge.checkpoint.id,requestId:'s37_rj_001'}})
push('E5',rj.status===200&&rj.body.checkpoint.status==='rejected','拒绝路由 proposed→rejected')
// E7 确认幂等（同 requestId 再确认）
const cf2=await call(M.CONFIRM_CHECKPOINT_PATH,{method:'POST',json:{id:cp.checkpoint.id,requestId:'s37_cf_001'}})
push('E7',cf2.body.replayed===true,'确认路由幂等，重复请求 replayed')
await store.close()
const pass=steps.filter(s=>s.ok).length
const summary={at:new Date().toISOString(),suite:'s37-checkpoint-e2e',total:steps.length,pass,fail:steps.length-pass,verdict:pass===steps.length?'PASS':'FAIL',steps}
await writeFile(OUT,JSON.stringify(summary,null,2),'utf8')
console.log('SUMMARY '+pass+'/'+steps.length+' '+summary.verdict)
process.exit(pass===steps.length?0:1)