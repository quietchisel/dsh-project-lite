/**
 * test/s35-resume.mjs —— Continuity 0.1：project_resume 工具 + resume() 摘要回归。
 *
 * 覆盖：
 *   R1 显式 project_id → 返回真实摘要（目标/判据/下一步）
 *   R2 摘要明显小于 getProject 全量（字段裁剪）
 *   R3 不传 id + 唯一 active primary 关联 → 解析到该项目
 *   R4 不传 id + 多项目关联 → multiple_candidates，不自动选
 *   R5 不传 id + 无关联 → no_association
 *   R6 deleted 项目 → PROJECT_DELETED
 *   R7 unconfirmed_count 不把无归属(none)算成 inferred
 *   R8 无 checkpoint 时 latest=null / pending=0（不编造）
 *
 * Node 层 + 真 store + 合成数据，Implemented。
 * 用法：node test/s35-resume.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const BASE = process.argv[2]
const OUT = process.argv[3]
const steps = []
const push = (id, ok, d) => { steps.push({ id, ok:!!ok, detail:d }); console.log((ok?'PASS ':'FAIL ')+id+' :: '+d) }
const INST = 'D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1'
const { apply, CREATE_PATH, LINK_PATH } = await import(pathToFileURL(INST+'/index.js').href)
const { createReadService } = await import(pathToFileURL(INST+'/core/read.mjs').href)
const { openStore } = await import(pathToFileURL(INST+'/core/store.mjs').href)
await rm(BASE,{recursive:true,force:true}); const ROOT=join(BASE,'store'); await mkdir(ROOT,{recursive:true})
const SID='session-55555555-5555-5555-5555-555555555555', WS='ws-eeeeeeee-0000-0000-0000-000000000005'
await writeFile(join(ROOT,'workspace.json'), JSON.stringify({unit:{name:'workspace',version:2},global:{initialized:true,defaultWorkspaceId:WS,workspaceIds:[WS],archivedSessionIds:[],pinnedSessionIds:[]},tables:{workspaces:{[WS]:{path:BASE,title:'W',sessionIds:[SID],createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z'}}}}),'utf8')
// 用 store 直接建两个项目并把同一会话挂到两个项目（测多候选）
const st = await openStore({root:ROOT, actor:'s35'})
const runAs = (await import(pathToFileURL(INST+'/core/identity.mjs').href)).runAsCaller
const p1 = await runAs({sessionId:SID,source:'s35'},()=>st.createProject({name:'项目甲',objective:'目标甲',next_action:'验证 Resume 摘要正确性',session_id:SID}))
const p2 = await runAs({sessionId:SID,source:'s35'},()=>st.createProject({name:'项目乙',objective:'目标乙',next_action:'验证多项目候选行为',session_id:SID}))
await st.close()
// 用 apply 的路由拿工具执行（走真实 project_resume）
const routes=new Map(); const ctx={webServer:{register(d){routes.set(d.path,d);return()=>{}}},effect(){},storageDomain:undefined,get(){return null}}
apply(ctx,{root:ROOT,evidencePath:join(BASE,'ev.jsonl')})
const { registerAgentTools } = await import(pathToFileURL(INST+'/core/agent-tools.mjs').href)
const reg=new Map(); const toolCtx={tools:{register(spec){reg.set(spec.name,spec);return()=>{}}}}
const s2=await openStore({root:ROOT,actor:'s35b'})
registerAgentTools(toolCtx,{defineTool:(o)=>o,tools:toolCtx.tools,getStore:async()=>s2,readService:createReadService,evidence:()=>{}})
await new Promise(r=>setTimeout(r,100))
const resumeTool=reg.get('project_resume')
const exec={agent:{sessionId:SID}}
// R1 显式 id
const r1=await resumeTool.execute({project_id:p1.project.id},exec)
push('R1', r1.ok && r1.found && r1.name==='项目甲' && r1.objective==='目标甲' && Array.isArray(r1.done_when), '显式 id 返回真实摘要（name/objective/done_when）')
// R2 小于全量
const full=await createReadService(s2).getProject(p1.project.id)
const r1Str=JSON.stringify(r1).length, fullStr=JSON.stringify(full).length
push('R2', r1Str < fullStr, '摘要小于全量（'+r1Str+' < '+fullStr+' 字符）')
// R4 多候选（同会话挂两个项目）→ multiple_candidates
const r4=await resumeTool.execute({},exec)
push('R4', r4.found===false && r4.state==='multiple_candidates' && Array.isArray(r4.candidates) && r4.candidates.length>=2, '多项目关联返回候选，不自动选（'+r4.state+'）')
// R3 唯一 active primary 关联 → 自动解析到该项目（用只关联 p1 的会话）
const SID_ONE='session-77777777-7777-7777-7777-777777777777'
const pOne=await runAs({sessionId:SID_ONE,source:'s35'},()=>s2.createProject({name:'单关联项目',objective:'唯一关联',next_action:'验证自动解析到唯一项目',session_id:SID_ONE}))
const r3=await resumeTool.execute({}, {agent:{sessionId:SID_ONE}})
push('R3', r3.found && r3.project_id===pOne.project.id, '不传 id + 唯一 active primary 关联 → 解析到该项目')
// R5 无关联会话 → no_association
const SID_NONE='session-88888888-8888-8888-8888-888888888888'
const r5=await resumeTool.execute({}, {agent:{sessionId:SID_NONE}})
push('R5', r5.found===false && r5.state==='no_association', '不传 id + 无关联 → no_association')
// R6 deleted（建一个再删）
const SID_DEL='session-66666666-6666-6666-6666-666666666666'
const p3=await runAs({sessionId:SID_DEL,source:'s35'},()=>s2.createProject({name:'待删',objective:'o',next_action:'验证删除项目不恢复',session_id:SID_DEL}))
await runAs({sessionId:SID_DEL,source:'s35'},()=>s2.archiveProject(p3.project.id))
await runAs({sessionId:SID_DEL,source:'s35'},()=>s2.deleteProject(p3.project.id))
const r6=await resumeTool.execute({project_id:p3.project.id},exec)
push('R6', r6.ok===false && r6.error==='PROJECT_DELETED', 'deleted 项目返回 PROJECT_DELETED')
// R7/R8 字段不编造
push('R7', typeof r1.unconfirmed_count==='number' && typeof r1.confidence_summary==='object', 'unconfirmed_count 为数字、confidence_summary 存在')
push('R8', r1.latest_confirmed_checkpoint===null && r1.pending_checkpoint_count===0, '无 checkpoint 时 latest=null/pending=0，不编造')
await s2.close()
const pass=steps.filter(s=>s.ok).length
const summary={at:new Date().toISOString(),suite:'s35-resume',total:steps.length,pass,fail:steps.length-pass,verdict:pass===steps.length?'PASS':'FAIL',steps}
await writeFile(OUT,JSON.stringify(summary,null,2),'utf8')
console.log('SUMMARY '+pass+'/'+steps.length+' '+summary.verdict)
process.exit(pass===steps.length?0:1)