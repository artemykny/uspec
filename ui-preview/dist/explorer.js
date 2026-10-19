// A single project hierarchy, retaining existing workflow and node interactions.
const specSection=$('spec-section');
const projectTree=specSection.querySelector('.tree');
const projectChildren=projectTree.querySelector('.unified-branch > div');
const changes=$('changes-section');
const typesBranch=[...document.querySelectorAll('.sidebar > details')].find(d=>d.querySelector('summary')?.textContent==='NODE TYPES');
changes.className='unified-branch explorer-group';
changes.querySelector('summary').innerHTML='<span class="group-label">◉ Changes</span><span class="branch-count">1</span>';
const newButton=$('new'),refreshButton=$('refresh');
// The old toolbar was inside the section label; replace it with one project toolbar.
const sideHeader=document.querySelector('.sidebar > header');
sideHeader.innerHTML='EXPLORER <span><button id="explorer-new" title="New change">＋</button><button id="explorer-refresh" title="Refresh explorer">⟳</button><button id="collapse-all" title="Collapse all branches">⊟</button></span>';
$('explorer-new').onclick=()=>{changes.open=true;setStage(0);action('openChangeMd');};
$('explorer-refresh').onclick=()=>toast('Explorer is up to date.');
$('collapse-all').onclick=()=>projectChildren.querySelectorAll('details').forEach(d=>d.open=false);
// Make the change itself an expandable item, just like a spec node or a node type.
const changeItem=document.createElement('details');changeItem.className='unified-branch change-item';changeItem.open=false;
const changeSummary=document.createElement('summary');const heading=document.querySelector('.change-heading');
changeSummary.append(heading);changeItem.append(changeSummary,$('change-tree'));changes.append(changeItem);
$('change-title').innerHTML='◉ refund-window <small>active</small>';
projectChildren.prepend(changes);
typesBranch.id='types-section';typesBranch.className='unified-branch explorer-group';typesBranch.querySelector('summary').innerHTML=`<span class="group-label">◇ Node types</span><span class="branch-count">${NODE_TYPES.length}</span>`;
typesBranch.querySelector('.tree').innerHTML=NODE_TYPES.map(t=>`<details class="unified-branch"><summary><button data-inspect-type="${escape(t.type)}">◇ ${escape(t.name)}<small>${NODES.filter(n=>n.type===t.type).length}</small></button></summary><div><button class="tree-document" data-type-yaml="${escape(t.type)}">⚙ node-type.yaml</button>${t.documents.map(d=>`<button class="tree-document" data-template="${escape(t.type)}|${escape(d.document)}">Ⓜ ${escape(d.document)}.md</button>`).join('')}</div></details>`).join('');
changes.after(typesBranch);typesBranch.open=true;
specSection.querySelector(':scope > summary').hidden=true;specSection.open=true;specSection.classList.add('single-explorer');
// Start with a compact project outline so all kinds of item are immediately discoverable.
for(const d of projectChildren.children){if(d.tagName==='DETAILS'&&d!==changes&&d!==typesBranch)d.open=false;}
$('spec-section').querySelector('.tree').scrollTop=0;document.querySelector('.sidebar').scrollTop=0;
function inspectType(id){const t=NODE_TYPES.find(t=>t.type===id);if(!t)return;$('state-frame').hidden=true;$('editor').hidden=true;$('node-overview').hidden=false;$('state-tab').classList.remove('active');$('file-tab').classList.remove('active');$('node-tab').classList.add('active');$('node-tab').textContent='◇ '+t.name+' · type';$('node-tab').onclick=()=>inspectType(id);$('breadcrumbs').textContent=`example_product › Node types › ${t.name}`;const instances=NODES.filter(n=>n.type===id);$('node-overview').innerHTML=`<div class="node-identity"><div><div class="eyebrow">NODE TYPE <span class="type-tag">${escape(t.type)}</span></div><h1>${escape(t.name)}</h1><div class="node-path">${escape(t.description)}</div></div><div class="node-actions"><button data-type-yaml="${escape(id)}">Open node-type.yaml ↗</button></div></div><div class="node-body"><section><h2>Document templates <span>${t.documents.length}</span></h2><div class="document-grid">${t.documents.map(d=>`<button class="document-card" data-template="${escape(id)}|${escape(d.document)}"><span class="doc-symbol">Ⓜ</span><span><strong>${escape(d.document)}.md</strong><small>${escape(d.description.trim().split('\n')[0])}</small></span><span class="type-tag">${d.required?'required':'optional'}</span></button>`).join('')}</div></section><div class="relationships"><section><h2>Derives from</h2>${t.derives_from.length?t.derives_from.map(x=>`<button class="type-link" data-inspect-type="${escape(x)}">◇ ${escape(x)} ↗</button>`).join(''):'<p class="empty-note">No upstream types.</p>'}</section><section><h2>Allowed children</h2>${t.children.length?t.children.map(x=>`<button class="type-link" data-inspect-type="${escape(x)}">◇ ${escape(x)} ↗</button>`).join(''):'<p class="empty-note">Leaf node — no child nodes.</p>'}</section></div><section><h2>Instructions</h2><p class="type-instructions">${escape(t.instructions||'No additional instructions.')}</p><p class="empty-note">${t.code?'Nodes of this type own code paths.':'Nodes of this type do not own code paths.'}</p></section><section class="type-instances"><h2>Nodes using this type <span>${instances.length}</span></h2>${instances.map(nodeLink).join('')}</section></div>`;document.querySelectorAll('.node-selected').forEach(e=>e.classList.remove('node-selected'));document.querySelector(`[data-inspect-type="${id}"]`)?.classList.add('node-selected');$('output').textContent=`Node type: ${t.name}\n${instances.length} nodes · ${t.documents.length} document templates`;}
document.addEventListener('click',e=>{const el=e.target.closest('[data-inspect-type],[data-type-yaml],[data-template]');if(!el)return;e.preventDefault();if(el.dataset.inspectType)inspectType(el.dataset.inspectType);else if(el.dataset.typeYaml){const t=NODE_TYPES.find(t=>t.type===el.dataset.typeYaml);showEditor(t.path,t.yaml);}else{const [type,doc]=el.dataset.template.split('|');const d=NODE_TYPES.find(t=>t.type===type).documents.find(d=>d.document===doc);showEditor(d.template,d.content);}});
const inspectSpecNode=inspectNode;inspectNode=function(key){document.querySelectorAll('.node-selected').forEach(e=>e.classList.remove('node-selected'));inspectSpecNode(key);$('node-tab').onclick=()=>inspectNode(selectedNode);};
$('change-title').onclick=e=>{e.preventDefault();openState();};
$('info').onclick=()=>modal('One project tree','<p>Spec nodes, changes, and node types now share one project tree. There are no separate sidebar views.</p><p>Click a name to inspect it in the main area. Click its chevron to expand its children. Node types open their templates, instructions, and the nodes that use them; changes open their workflow.</p>');
inspectType('service');
// Three top-level branches: workflow, schema, and specification.
const specificationBranch=document.createElement('details');
specificationBranch.className='unified-branch explorer-group';
specificationBranch.id='specification-branch';
specificationBranch.open=true;
specificationBranch.innerHTML=`<summary><span class="group-label">▣ Specification</span><span class="branch-count">${NODES.length}</span></summary><div></div>`;
const specificationChildren=specificationBranch.querySelector('div');
for(const child of [...projectChildren.children]) {
  if(child!==changes&&child!==typesBranch)specificationChildren.append(child);
}
projectTree.replaceChildren(changes,typesBranch,specificationBranch);
changes.open=true;typesBranch.open=false;
$('collapse-all').onclick=()=>projectTree.querySelectorAll('details').forEach(d=>d.open=false);
$('info').onclick=()=>modal('One explorer, three roots','<p><strong>Changes</strong> contains change workflows and agent runs.</p><p><strong>Node types</strong> contains type definitions and document templates.</p><p><strong>Specification</strong> contains the product’s spec nodes and documents.</p><p>Select an item to inspect it in the main area.</p>');
document.querySelector('.sidebar').scrollTop=0;
