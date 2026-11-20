/**
 * test/s43-suggested-title.mjs —— 0.20 建议侧栏标题（只读、供人复制改名）。
 * 验证：格式【角色】任务短名 · 当前工作（T-xxxx MMDD）；primary→主 / supporting→执行；
 * 无会话身份→null；有 T-xxxx 任务带编号；不写宿主数据。
 * 用法：node test/s43-suggested-title.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const BASE=process.argv[2], OUT=process.argv[3]
const steps=[]
const push=(id,ok,d)=>{steps.push({id,ok:!!ok,detail:d});console.log((ok?'PASS ':'FAIL ')+id+' :: '+d)}
const INST='D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1'
const { openStore }=await import(pathToFileURL(INST+'/core/store.mjs').href)
const { runAsCaller }=await import(pathToFileURL(INST+'/core/identity.mjs').href)
const { createReadService }=await import(pathToFileURL(INST+'/core/read.mjs').href)
const { registerAgentTools }=await import(pathToFileURL(INST+'/core/agent-tools.mjs').href)
const P='session-10000000-0000-4000-8000-000000000001', S='session-20000000-0000-4000-8000-000000000002'
await rm(BASE,{recursive:true,force:true}); const ROOT=join(BASE,'store'); await mkdir(ROOT,{recursive:true})
const st=await openStore({root:ROOT,actor:'s43'})
const as=(sid,fn)=>runAsCaller({sessionId:sid,source:'s43'},fn)
const pj=(await as(P,()=>st.createProject({name:'多分支协作机制',objective:'验证建议名',next_action:'派三个子任务给分支',session_id:P}))).project
await as(P,()=>st.linkSession({project_id:pj.id,session_id:S,role:'supporting',basis:'分支'}))
await st.close()
const s2=await openStore({root:ROOT,actor:'s43b'}); const reg=new Map(); const ctx={tools:{register(sp){reg.set(sp.name,sp);return()=>{}}}}
registerAgentTools(ctx,{defineTool:o=>o,tools:ctx.tools,getStore:async()=>s2,readService:createReadService,evidence:()=>{}})
await new Promise(r=>setTimeout(r,50))
const resume=reg.get('project_resume'); const exec=sid=>({agent:{session:{id:sid}}})
// T1 primary 建议名格式
const r1=await resume.execute({project_id:pj.id},exec(P))
const t1=r1.suggested_session_title
push('T1', /^【主】.+ · .+（\d{4}）$/.test(t1), 'primary 建议名格式：'+t1)
// T2 任务短名来自项目名（≤8 字），当前工作来自 next_action
push('T2', t1.includes('多分支协作机制') && t1.includes('派三个子任务给分支'), '短名取自项目名、当前工作取自 next_action')
// T3 supporting → 【执行】
const r2=await resume.execute({project_id:pj.id},exec(S))
push('T3', /^【执行】/.test(r2.suggested_session_title), 'supporting 建议名前缀【执行】：'+r2.suggested_session_title)
// T4 无会话身份 → null
const r3=await resume.execute({project_id:pj.id},{})
push('T4', r3.suggested_session_title===null, '无宿主会话身份 → suggested=null')
// T5 带 T-xxxx 任务时编号进括号
const tk=(await as(P,()=>s2.createTask({project_id:pj.id,title:'文稿任务',objective:'写稿',source_id:'T-0099'}))).task
await as(P,()=>s2.assignTask({task_id:tk.id,assigned_session_id:S}))
const r4=await resume.execute({project_id:pj.id},exec(S))
push('T5', r4.suggested_session_title.includes('T-0099'), '有关联任务时带 T-xxxx 编号：'+r4.suggested_session_title)
// T6 不写宿主：workspace.json 未被插件改（本测试没建 workspace.json，确认插件没造一个）
import { existsSync } from 'node:fs'
push('T6', !existsSync(join(ROOT,'workspace.json')), '插件未写 workspace.json（不碰宿主数据）')
await s2.close()
const pass=steps.filter(x=>x.ok).length
const sum={at:new Date().toISOString(),suite:'s43-suggested-title',total:steps.length,pass,fail:steps.length-pass,verdict:pass===steps.length?'PASS':'FAIL',steps}
await writeFile(OUT,JSON.stringify(sum,null,2),'utf8')
console.log('SUMMARY '+pass+'/'+steps.length+' '+sum.verdict)
process.exit(pass===steps.length?0:1)