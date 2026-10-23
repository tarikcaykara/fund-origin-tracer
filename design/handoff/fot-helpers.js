(function(){
const CAT={exchange:{g:'■',t:'Exchange'},dex:{g:'◆',t:'DEX'},bridge:{g:'⇄',t:'Bridge'},mixer:{g:'◎',t:'Mixer'},sanctioned:{g:'⊘',t:'Sanctioned'},scam:{g:'✕',t:'Scam'},defi:{g:'◈',t:'DeFi'},token:{g:'●',t:'Token'},other:{g:'○',t:'Other'}};
const legend=Object.keys(CAT).map(k=>({k,g:CAT[k].g,t:CAT[k].t,color:'var(--c-'+k+')'}));
// opts: W,H,padX,padY,nodeW,nodeH,weight(node)->n, gapY
function layout(G,o){
  const cols={};G.nodes.forEach(n=>{if(o.hide&&o.hide[n.id])return;(cols[n.col]=cols[n.col]||[]).push(n)});
  Object.values(cols).forEach(c=>c.sort((a,b)=>a.row-b.row));
  if(o.extra)o.extra.forEach(n=>{(cols[n.col]=cols[n.col]||[]).push(n);cols[n.col].sort((a,b)=>a.row-b.row)});
  const w=o.weight||(()=>1);
  let maxW=0;Object.values(cols).forEach(c=>{maxW=Math.max(maxW,c.reduce((s,n)=>s+w(n),0))});
  const unit=o.unit||Math.min(o.maxUnit||999,(o.H-2*o.padY)/maxW);
  const nc=G.maxCol;const colX=o.colXFn||(c=>o.padX+c*((o.W-2*o.padX-o.nodeW)/nc));
  const pos={};const out=[];
  Object.entries(cols).forEach(([c,ns])=>{const tot=ns.reduce((s,n)=>s+w(n),0)*unit;let y=o.H/2-tot/2;
    ns.forEach(n=>{const h=w(n)*unit;const nh=o.nodeHFn?o.nodeHFn(n,h):Math.min(o.nodeH,h-2);const p={...n,x:Math.round(colX(+c)),y:Math.round(y+h/2-nh/2),h:nh,w:o.nodeWFn?o.nodeWFn(n):o.nodeW};
      p.cx=p.x+p.w/2;p.cy=p.y+nh/2;p.color=n.cat?'var(--c-'+n.cat+')':'var(--fg)';p.glyph=n.cat?CAT[n.cat].g:'';pos[n.id]=p;out.push(p);y+=h;});});
  const sel=new Set(o.selPath||[]);const edges=[];const map=o.remap||{};
  const seen={};
  G.pairs.forEach(p=>{const f=pos[map[p.from]||p.from],t=pos[map[p.to]||p.to];if(!f||!t)return;const key=f.id+'>'+t.id;
    const x1=f.x+f.w,y1=f.cy,x2=t.x,y2=t.cy;const dx=Math.max(30,(x2-x1)/2);
    const d=x2>x1?`M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`:`M${f.cx},${f.y} C${f.cx},${f.y-60} ${t.cx},${t.y-60} ${t.cx},${t.y}`;
    const onPath=p.edgeIds.some(id=>sel.has(id));
    if(seen[key]){seen[key].n+=p.n;return;}
    const e={...p,d,mx:Math.round((x1+x2)/2),my:Math.round((y1+y2)/2),onPath,sel:o.selPair&&p.from===o.selPair[0]&&p.to===o.selPair[1]};seen[key]=e;edges.push(e);});
  const join=fn=>edges.filter(fn).map(e=>e.d).join(' ');
  return {nodes:out,pos,edges,dAll:join(e=>!e.onPath&&!e.stopped),dStopped:join(e=>!e.onPath&&e.stopped),dPath:join(e=>e.onPath),dSel:join(e=>e.sel),colX,unit};
}
function shortTitle(s){return s}
window.FOTH={CAT,legend,layout};
})();
