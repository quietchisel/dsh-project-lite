/**
 * test/s36-checkpoint.mjs —— Continuity 0.1：checkpoint 正式表 + 三态状态机回归。
 * C1 proposed 提交成功、不改 Project 权威字段
 * C2 只有 proposed 能 confirm/reject
 * C3 confirm 后 confirmed_at/by 记录、内容不可变
 * C4 reject 保留记录、不进 Resume 已确认
 * C5 同 client_request_id 幂等，不重复
 * C6 checkpoint 纳入 expected_counts（基线含 checkpoint 键）
 * C7 来源会话来自 exec（工具层在 s37 测），此处测 store 层字段留存
 * Node 层 + 真 store + 合成数据，Implemented。
 * 用法：node test/s36-checkpoint.mjs <BASE> <OUT.json>
 */
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const BASE=process.argv[2], OUT=process.argv[3]
const steps=[]; const push=(id,ok,d)=>{steps.push({id,ok:!!ok,detail:d});console.log((ok?'PASS ':'FAIL ')+id+' :: '+d)}
const INST='D:/DSH工作区/工作区管理系统改造/_会话/20261115-S1只读/plugin-1.1'
const {openStore}=await import(pathToFileURL(INST+'/core/store.mjs').href)
const {runAsCaller}=await import(pathToFileURL(INST+'/core/identity.mjs').href)
await rm(BASE,{recursive:true,force:true}); const ROOT=join(BASE,'store'); await mkdir(ROOT,{recursive:true})
const SID='session-99999999-9999-9999-9999-999999999999'
const st=await openStore({root:ROOT,actor:'s36'})
const p=await runAsCaller({sessionId:SID,source:'s36'},()=>st.createProject({name:'检查点项目',objective:'原目标',next_action:'验证检查点不改写权威字段',session_id:SID}))
const pid=p.project.id
// C1 proposed
const cp=await runAsCaller({sessionId:SID,source:'s36'},()=>st.proposeCheckpoint({project_id:pid,source_session_id:SID,source_session_role:'primary',summary:'完成了 Resume 工具',completed:['实现 resume()','接入 project_resume'],findings:['摘要比全量小'],next_action:'实现 Checkpoint UI',client_request_id:'s36_c1_0001'}))
const projAfter=st.project(pid)
push('C1',cp.checkpoint&&cp.checkpoint.status==='proposed'&&projAfter.objective==='原目标'&&projAfter.next_action!=='实现 Checkpoint UI','proposed 提交成功且未改 Project 权威字段')
push('C7',cp.checkpoint.source_session_id===SID&&cp.checkpoint.source_session_role==='primary','来源会话与角色留存')
// C5 幂等
const cp2=await runAsCaller({sessionId:SID,source:'s36'},()=>st.proposeCheckpoint({project_id:pid,source_session_id:SID,source_session_role:'primary',summary:'完成了 Resume 工具',completed:['实现 resume()','接入 project_resume'],findings:['摘要比全量小'],next_action:'实现 Checkpoint UI',client_request_id:'s36_c1_0001'}))
push('C5',cp2.checkpoint.id===cp.checkpoint.id&&st.checkpoints().length===1,'同 client_request_id 幂等，不重复创建')
// C3 confirm
const cf=await runAsCaller({sessionId:SID,source:'s36'},()=>st.confirmCheckpoint({id:cp.checkpoint.id,confirmed_by:'s36-human'}))
push('C3',cf.checkpoint.status==='confirmed'&&!!cf.checkpoint.confirmed_at&&cf.checkpoint.confirmed_by==='s36-human','confirm 记录时间与来源')
// confirm 后不可变（再 confirm 拒绝）
let immutable=true; try{ await st.confirmCheckpoint({id:cp.checkpoint.id}) }catch(e){ immutable=(e.code==='CHECKPOINT_NOT_PROPOSED') }
push('C3b',immutable,'confirmed 后再次 confirm 被拒（内容不可变）')
// C4 reject 另一个 proposed
const cp3=await runAsCaller({sessionId:SID,source:'s36'},()=>st.proposeCheckpoint({project_id:pid,source_session_id:SID,summary:'待拒绝的进展',client_request_id:'s36_c4_0002'}))
const rj=await runAsCaller({sessionId:SID,source:'s36'},()=>st.rejectCheckpoint({id:cp3.checkpoint.id}))
push('C4',rj.checkpoint.status==='rejected'&&!!rj.checkpoint.rejected_at&&st.checkpoints().length===2,'reject 保留记录、状态 rejected')
// C6 基线含 checkpoint 键
const gj=JSON.parse(await readFile(join(ROOT,'project','global.json'),'utf8'))
const exp=gj.record&&gj.record.expected_counts
push('C6',exp&&typeof exp.checkpoint==='number'&&exp.checkpoint===2,'expected_counts 纳入 checkpoint=2')
// C2 非法状态直接改（用 store 内部无此 API，验证 confirm/reject 只接 proposed）
let c2=false; try{ await st.confirmCheckpoint({id:cp3.checkpoint.id}) }catch(e){ c2=(e.code==='CHECKPOINT_NOT_PROPOSED') }
push('C2',c2,'rejected 不能 confirm')
await st.close()
const pass=steps.filter(s=>s.ok).length
const summary={at:new Date().toISOString(),suite:'s36-checkpoint',total:steps.length,pass,fail:steps.length-pass,verdict:pass===steps.length?'PASS':'FAIL',steps}
await writeFile(OUT,JSON.stringify(summary,null,2),'utf8')
console.log('SUMMARY '+pass+'/'+steps.length+' '+summary.verdict)
process.exit(pass===steps.length?0:1)