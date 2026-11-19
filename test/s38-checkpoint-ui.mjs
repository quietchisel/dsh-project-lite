/**
 * test/s38-checkpoint-ui.mjs —— Continuity 0.1：检查点 UI 渲染回归。
 * U1 详情含 data-checkpoints 区域（8 区）
 * U2 proposed 检查点显示「确认并保存」「拒绝」按钮
 * U3 confirmed 检查点显示「已确认」标签、无操作按钮
 * U4 来源会话标题注入（人可读）
 * U5 待确认/已确认计数正确
 * Node 层 vm 加载真实 client.js，Implemented。
 * 用法：node test/s38-checkpoint-ui.mjs <OUT.json>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
const HERE=dirname(fileURLToPath(import.meta.url)), SRC=join(HERE,'..','client.js'), OUT=process.argv[2]
const steps=[], push=(id,ok,d)=>{steps.push({id,ok:!!ok,detail:d});console.log((ok?'PASS ':'FAIL ')+id+' :: '+d)}
const src=await readFile(SRC,'utf8')
function findAll(n,pred,out=[]){if(n==null||typeof n!=='object')return out;if(Array.isArray(n)){for(const c of n)findAll(c,pred,out);return out}if(pred(n))out.push(n);if(n.children)for(const c of n.children)findAll(c,pred,out);return out}
const DETAIL={ok:true,found:true,project:{id:'prj_x',name:'UI项目',objective:'o',next_action:'验证检查点UI',status:'active',confidence:'confirmed',rev:1,basis:'b',done_when:[]},sessions:[],workspaces:[],tasks:[],deliverables:[],logs:[],counts:{sessions:0,tasks:0,deliverables:0,logs:0,unconfirmed:0},unconfirmed:[],degradation:{degraded:false,writable:true}}
const OVERVIEW={ok:true,writable:true,degraded:false,metaState:'ok',total:1,counts:{active:1},groups:[{key:'active',count:1,items:[{id:'prj_x',name:'UI项目',status:'active',confidence:'confirmed',next_action:'验证检查点UI'}]}],degradation:{degraded:false,writable:true}}
const CPS={ok:true,total:3,checkpoints:[
  {id:'cp_p1',project_id:'prj_x',status:'proposed',summary:'完成了 Resume',completed:['resume()'],findings:[],next_action:'确认',open_questions:[],source_session_id:'session-aaaabbbb',source_session_title:'会话A标题',created_at:'2026-11-20T06:00:00Z'},
  {id:'cp_c1',project_id:'prj_x',status:'confirmed',summary:'已确认的进展',source_session_id:'session-cccddddd',source_session_title:'会话C标题',created_at:'2026-11-19T06:00:00Z',confirmed_at:'2026-11-19T07:00:00Z'},
  {id:'cp_r1',project_id:'prj_x',status:'rejected',summary:'被拒绝的进展',source_session_id:'session-eeefffff',created_at:'2026-11-18T06:00:00Z'},
]}
function fakeFetch(url){let payload=OVERVIEW;const u=String(url);if(u.includes('api/project/state'))payload={ok:true,root:'R',writable:true,metaState:'ok',counts:{},degradation:{degraded:false},reconcile:{pass:9,fail:0,skipped:0,total:9}};else if(u.includes('api/project/get'))payload=DETAIL;else if(u.includes('api/project/checkpoints'))payload=CPS;else if(u.includes('api/project/workspaces'))payload={ok:true,sessions:[]};return Promise.resolve({status:200,json:()=>Promise.resolve(payload)})}
const slots=[],effects=[];let cursor=0
const React={createElement(t,p,...c){return{type:t,props:p||{},children:c.flat(Infinity).filter(x=>x!=null&&x!==false)}},useState(i){const k=cursor++;if(!(k in slots))slots[k]=typeof i==='function'?i():i;return[slots[k],v=>{slots[k]=typeof v==='function'?v(slots[k]):v}]},useCallback(fn){return fn},useEffect(fn){effects.push(fn)}}
const captured={};const sandbox={window:{__ModuleLoader__:{load(s){captured.spec=s}}},fetch:fakeFetch,console,setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{},Promise,JSON,Object,Array,Number,String,Date,Error,Math,encodeURIComponent}
vm.runInNewContext(src,sandbox,{filename:'client.js'})
const plugin=captured.spec.factory(n=>{if(n==='react')return React;throw new Error('req '+n)})
let slot=null;const ctx={slots:{inject(s,fn){slot=s;fn()},register(m,C){if(slot==='main')captured.main=C}}};plugin.apply(ctx)
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()}
const render=()=>{cursor=0;effects.length=0;return captured.main()}
let tree=render();effects.forEach(f=>f());await flush();tree=render()
// 点开项目标题（open-detail）
const openBtn=findAll(tree,n=>n.props&&n.props['data-action']==='open-detail')[0]
openBtn.props.onClick();await flush();tree=render();await flush();tree=render()
// U1
const cpZone=findAll(tree,n=>n.props&&n.props['data-checkpoints']==='1')[0]
push('U1',!!cpZone,'详情含 data-checkpoints 区域（8 区）')
// U2 待确认按钮
const confirmBtn=findAll(tree,n=>n.props&&n.props['data-action']==='confirm-checkpoint')[0]
const rejectBtn=findAll(tree,n=>n.props&&n.props['data-action']==='reject-checkpoint')[0]
push('U2',!!confirmBtn&&!!rejectBtn&&confirmBtn.props['data-for']==='cp_p1','proposed 检查点有确认/拒绝按钮')
// U3 已确认无操作按钮 + 标签
const cpRows=findAll(tree,n=>n.props&&n.props['data-checkpoint-id'])
const confirmedRow=cpRows.find(n=>n.props['data-checkpoint-id']==='cp_c1')
const confirmedHasBtn=confirmedRow&&findAll(confirmedRow,n=>n.props&&(n.props['data-action']==='confirm-checkpoint'||n.props['data-action']==='reject-checkpoint')).length>0
push('U3',!!confirmedRow&&confirmedRow.props['data-checkpoint-status']==='confirmed'&&!confirmedHasBtn,'confirmed 检查点显示已确认、无操作按钮')
// U4 来源标题
push('U4',JSON.stringify(cpZone).includes('会话A标题'),'来源会话标题人可读展示')
// U5 计数
push('U5',JSON.stringify(cpZone).includes('待确认 1')&&JSON.stringify(cpZone).includes('已确认 1'),'待确认/已确认计数正确')
const pass=steps.filter(s=>s.ok).length
const summary={at:new Date().toISOString(),suite:'s38-checkpoint-ui',total:steps.length,pass,fail:steps.length-pass,verdict:pass===steps.length?'PASS':'FAIL',steps}
await writeFile(OUT,JSON.stringify(summary,null,2),'utf8')
console.log('SUMMARY '+pass+'/'+steps.length+' '+summary.verdict)
process.exit(pass===steps.length?0:1)