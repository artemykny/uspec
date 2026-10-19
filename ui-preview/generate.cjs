const fs=require('fs'),vm=require('vm'),path=require('path');
const ts=require('../vscode/node_modules/typescript');
const base=path.resolve('../vscode');
const labels={affected:'Affected',pending:'Pending',updated:'Updated','no-change':'No change'};
const source=fs.readFileSync(path.resolve(__dirname,'../vscode/src/views/stateWindow.ts'),'utf8')+'\nexport { page };';
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const mod={exports:{}};
const summary=c=>`${c.counts.pending} pending, ${c.counts.affected} affected, ${c.counts.updated} updated, ${c.counts.no_change} no-change; ${c.counts.implementation_pending} to implement`;
vm.runInNewContext(output,{exports:mod.exports,require:n=>{
 if(n==='vscode')return {};
 if(n==='../projects')return {STATE_LABEL:labels,readText:async()=> '# Extend the refund window\n\nCustomers can request refunds within 30 days.'};
 if(n==='./changesView')return {summary};
 if(n.startsWith('../core/'))return require(path.resolve(__dirname,'../vscode/out/core',n.split('/').pop()+'.js'));
 return require(n);
}});
const names=['Waiting for the user','Selecting starting documents','Triage and write','Making plans','Running plans','Ready to close'];
const docs=['product/support/refunds/rules.md','system/services/payments/api.md','system/services/payments/logic.md','experience/ops-console/refunds/states.md'];
const plans=['payments','refunds'].map((plan,i)=>({plan,path:`.uspec/changes/refund-window/plans/${plan}.md`,nodes:[i?'experience/ops-console/refunds':'system/services/payments'],after:i?['payments']:[],state:'pending'}));
const snapshots=[];
(async()=>{for(let at=0;at<6;at++){
const c={name:'refund-window',baseline:'a82c4d7913f',counts:{pending:at===2?1:0,affected:at===2?1:0,updated:at>=3?4:at===2?2:0,no_change:0,implementation_pending:at>=3&&at<5?2:0,implementation_done:at===5?2:0},docs:new Map(),impl:new Map(),plans:at>=3?structuredClone(plans):[],next:{impact:at<2?{}:null,plan:null,plan_errors:[],implement:at===4?[plans[0]]:[],write:[],triage:null}};
if(at>=2) docs.forEach((d,i)=>c.docs.set(d,{document:d,state:at===2?(i===1?'affected':i===2?'pending':'updated'):'updated',reason:i===1?'Refund window is now 30 days.':undefined,via:i===2?['depends on api.md']:[]}));
if(at===5)c.plans.forEach(p=>p.state='done');
const run=(role,state,item='change')=>({id:at+1,role,state,item,title:`${role}: ${item}`,docs:[],starting:[],plans:[],outcome:state==='running'?'running':'to approve'});
let runs=[];
if(at===1){let r=run('impact','needs-approval');r.starting=[{document:docs[0],reason:'The requested change starts with the refund policy.'}];runs=[r];}
if(at===2){let r=run('writer','needs-approval','system/services/payments');r.docs=[{key:docs[1],state:'needs-approval',outcome:'Extended the refund eligibility window to 30 days.'}];runs=[r];}
if(at===3){let r=run('planner','needs-approval');r.plans=plans.map(x=>x.path);runs=[r];}
if(at===4)runs=[run('implementer','running','payments')];
const p={abs:x=>x};const agents={runsOf:()=>runs,isLooping:()=>at===4,isRunning:()=>at===4,describe:r=>r.state==='running'?'running · 12s':r.state==='needs-approval'?'waiting for approval':r.state};
const host=Object.create(mod.exports.StateWindows.prototype);host.agents=agents;
const body=await host.body(p,c);
let html=mod.exports.page('preview','refund-window',body).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'');
html=html.replace('<style nonce="preview">',`<style nonce="preview">:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-textLink-foreground:#4daafc;--vscode-editor-font-family:monospace;--vscode-descriptionForeground:#969696;--vscode-errorForeground:#f48771;--vscode-charts-green:#89d185;--vscode-charts-blue:#4daafc;--vscode-focusBorder:#007fd4;--vscode-button-background:#0e639c;--vscode-button-foreground:white;--vscode-button-hoverBackground:#1177bb}body{background:#1f1f1f}h1{font-size:26px}`);
html=html.replace('const vscode = acquireVsCodeApi();',"const vscode = {postMessage: m => parent.postMessage({uspecPreview:true,...m},location.origin)};");
fs.writeFileSync(path.join(__dirname,`dist/state-${at}.html`),html);
snapshots.push({name:names[at],summary:summary(c),docs:[...c.docs.values()],plans:c.plans,runs:runs.map(r=>({title:r.title,state:r.state,role:r.role})),at});
}
fs.writeFileSync(path.join(__dirname,'dist/data.js'),'window.SCENARIOS='+JSON.stringify(snapshots)+';\nwindow.SAMPLE_DOC='+JSON.stringify(fs.readFileSync(path.resolve(__dirname,'../examples/example_product/docs/product/support/refunds/rules.md'),'utf8'))+';');
})();
