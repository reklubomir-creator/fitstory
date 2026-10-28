/* RADAR HUBEŇOUR: FIT/Hevy heart-rate import, entirely in the browser. */
(function(){
'use strict';
const byId=id=>document.getElementById(id);
function sample(points,limit=480){
  if(points.length<=limit)return points;
  const result=[];const buckets=Math.max(1,Math.floor(limit/2));
  for(let b=0;b<buckets;b++){
    const start=Math.floor(b*points.length/buckets),end=Math.floor((b+1)*points.length/buckets);
    if(end<=start)continue;
    let lo=points[start],hi=points[start];
    for(let i=start+1;i<end;i++){if(points[i][1]<lo[1])lo=points[i];if(points[i][1]>hi[1])hi=points[i]}
    result.push(...(lo[0]===hi[0]?[lo]:lo[0]<hi[0]?[lo,hi]:[hi,lo]));
  }
  return result;
}
async function unpack(file){
  if(file.size>30*1024*1024)throw Error('Soubor je větší než 30 MB');
  if(!file.name.toLowerCase().endsWith('.gz'))return file.arrayBuffer();
  if(typeof DecompressionStream==='undefined')throw Error('Prohlížeč nepodporuje rozbalování gzip. Aktualizuj Safari.');
  return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
function fitRecords(buffer){
  const v=new DataView(buffer),bytes=new Uint8Array(buffer);
  if(v.byteLength<16||String.fromCharCode(...bytes.slice(8,12))!=='.FIT')throw Error('Neplatný FIT soubor');
  const header=v.getUint8(0),length=v.getUint32(4,true),end=header+length;
  if(header<12||end>v.byteLength)throw Error('Poškozený FIT soubor');
  const defs=Array(16).fill(null),last=Array(16).fill(null);
  const records=[];let pos=header;
  function val(p,size,type,le){
    const t=type&31;
    if(t===0||t===2||t===10||t===13){if(size!==1)return null;const x=v.getUint8(p);return x===255?null:x}
    if(t===1){if(size!==1)return null;const x=v.getInt8(p);return x===127?null:x}
    if(t===3){if(size!==2)return null;const x=v.getInt16(p,le);return x===32767?null:x}
    if(t===4||t===11){if(size!==2)return null;const x=v.getUint16(p,le);return x===65535?null:x}
    if(t===5){if(size!==4)return null;const x=v.getInt32(p,le);return x===2147483647?null:x}
    if(t===6||t===12){if(size!==4)return null;const x=v.getUint32(p,le);return x===4294967295?null:x}
    if(t===8&&size===4){const x=v.getFloat32(p,le);return Number.isFinite(x)?x:null}
    return null;
  }
  while(pos<end){
    const head=v.getUint8(pos++);
    const compressed=(head&128)!==0,local=compressed?(head>>5)&3:head&15;
    if(!compressed&&(head&64)){
      if(pos+5>end)throw Error('Neúplná definice FIT');
      pos++;const le=v.getUint8(pos++)===0;const global=v.getUint16(pos,le);pos+=2;
      const count=v.getUint8(pos++),fields=[];
      if(pos+count*3>end)throw Error('Poškozená definice FIT');
      for(let i=0;i<count;i++){fields.push([v.getUint8(pos),v.getUint8(pos+1),v.getUint8(pos+2)]);pos+=3}
      if(head&32){if(pos>=end)throw Error('Poškozené vývojářské pole FIT');const n=v.getUint8(pos++);if(pos+n*3>end)throw Error('Poškozené vývojářské pole FIT');for(let i=0;i<n;i++){fields.push([-1,v.getUint8(pos+1),13]);pos+=3}}
      defs[local]={global,le,fields};continue;
    }
    const def=defs[local];if(!def)throw Error('FIT záznam bez definice');
    let timestamp=null,heart=null;
    for(const [field,size,type] of def.fields){
      if(pos+size>end)throw Error('Neúplný FIT záznam');
      if(def.global===20&&field===253)timestamp=val(pos,size,type,def.le);
      if(def.global===20&&field===3)heart=val(pos,size,type,def.le);
      pos+=size;
    }
    if(def.global!==20)continue;
    if(compressed){
      const offset=head&31;
      if(last[local]!==null){timestamp=(last[local]&~31)+offset;if(timestamp<last[local])timestamp+=32}
    }
    if(timestamp!==null)last[local]=timestamp;
    if(timestamp!==null&&heart!==null&&heart>=30&&heart<=240){
      const epoch=(timestamp+631065600)*1000;
      if(Number.isFinite(epoch))records.push([epoch,heart]);
    }
  }
  if(!records.length)throw Error('FIT neobsahuje použitelná měření tepu');
  records.sort((a,b)=>a[0]-b[0]);
  const first=records[0][0];
  return {points:records.map(([ms,hr])=>[Math.round((ms-first)/1000),hr]),date:new Date(first).toISOString().slice(0,10)};
}
function hevyRecords(buffer){
  const json=JSON.parse(new TextDecoder().decode(buffer));
  const times=json.streams?.time,hearts=json.streams?.heartrate;
  if(!Array.isArray(times)||!Array.isArray(hearts))throw Error('JSON nemá Hevy časovou řadu tepu');
  const points=times.slice(0,hearts.length).map((t,i)=>[Number(t),Number(hearts[i])]).filter(([t,hr])=>Number.isFinite(t)&&t>=0&&Number.isFinite(hr)&&hr>=30&&hr<=240).sort((a,b)=>a[0]-b[0]);
  if(!points.length)throw Error('JSON neobsahuje použitelná měření tepu');
  return {points,date:typeof json.start_time==='string'?json.start_time.slice(0,10):null};
}
function tcxRecords(buffer){
  const xml=new DOMParser().parseFromString(new TextDecoder().decode(buffer),'application/xml');
  if(xml.querySelector('parsererror'))throw Error('Neplatné XML v TCX');
  const nodes=[...xml.getElementsByTagName('Trackpoint')];
  const raw=[];
  for(const node of nodes){
    const time=node.getElementsByTagName('Time')[0]?.textContent;
    const hr=node.getElementsByTagName('Value')[0]?.textContent;
    const ms=Date.parse(time),bpm=Number(hr);
    if(Number.isFinite(ms)&&Number.isFinite(bpm)&&bpm>=30&&bpm<=240)raw.push([ms,bpm]);
  }
  if(raw.length<2)throw Error('TCX neobsahuje průběh tepu');
  raw.sort((a,b)=>a[0]-b[0]);
  const start=raw[0][0];
  return {points:raw.map(([ms,bpm])=>[Math.round((ms-start)/1000),bpm]),date:new Date(start).toISOString().slice(0,10)};
}
function aggregate(record,source){
  const points=sample(record.points);
  const bpm=record.points.map(p=>p[1]);
  return {points,source,min:Math.min(...bpm),max:Math.max(...bpm),avg:Math.round(bpm.reduce((a,b)=>a+b,0)/bpm.length),duration:record.points.at(-1)[0],samples:record.points.length};
}
function chartMarkup(heart){
  if(!heart||!Array.isArray(heart.points)||heart.points.length<2)return '';
  const points=heart.points.filter(p=>Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&p[0]>=0&&p[1]>=30&&p[1]<=240);
  if(points.length<2)return '';
  const w=760,h=240,left=42,right=14,top=18,bottom=32;
  const xmax=Math.max(1,...points.map(p=>p[0])),ymin=Math.max(30,Math.floor(Math.min(...points.map(p=>p[1]))/20)*20-10),ymax=Math.min(240,Math.ceil(Math.max(...points.map(p=>p[1]))/20)*20+10);
  const x=t=>left+t/xmax*(w-left-right),y=hr=>top+(ymax-hr)/(ymax-ymin||1)*(h-top-bottom);
  let path='',previous=null;
  for(const p of points){
    const gap=previous&&p[0]-previous[0]>90;
    path+=(previous&&!gap?'L':'M')+x(p[0]).toFixed(1)+','+y(p[1]).toFixed(1)+' ';
    previous=p;
  }
  const grids=[0,1,2,3,4].map(i=>{const hr=Math.round(ymin+(ymax-ymin)*i/4),yy=y(hr);return '<line x1="'+left+'" y1="'+yy+'" x2="'+(w-right)+'" y2="'+yy+'" stroke="#354638"/><text x="3" y="'+(yy+4)+'" fill="#a4b5a6" font-size="12">'+hr+'</text>'}).join('');
  const minutes=Math.round(xmax/60);const stats=[heart.min,heart.avg,heart.max].map(v=>Number.isFinite(Number(v))?Math.round(Number(v)):'—');
  return '<div class="heart-panel"><div class="heart-summary"><strong>Tep během tréninku</strong><span>Min. '+stats[0]+' · Prům. '+stats[1]+' · Max. '+stats[2]+' tepů/min</span></div>'+
    '<svg class="heart-chart" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="Průběh tepové frekvence během '+minutes+' minut">'+grids+
    '<path d="'+path+'" fill="none" stroke="#b4ed63" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'+
    '<text x="'+left+'" y="'+(h-8)+'" fill="#a4b5a6" font-size="12">0 min</text><text x="'+(w-right)+'" y="'+(h-8)+'" text-anchor="end" fill="#a4b5a6" font-size="12">'+minutes+' min</text></svg>'+
    '<p class="muted tiny">Časová osa odpovídá záznamu. Delší výpadky měření nejsou spojeny čarou.</p></div>';
}
window.radarHeartChart=chartMarkup;
async function importFiles(files){
  const status=byId('heartImportStatus');
  if(document.body.classList.contains('guest')){status.textContent='Nejdříve se přihlas do administrace.';return}
  const selected=Array.from(files).filter(f=>/\.(fit|fit\.gz|tcx|tcx\.gz|json\.gz)$/i.test(f.name));
  if(!selected.length){status.textContent='Ve výběru nejsou podporované soubory FIT / FIT.GZ / TCX / JSON.GZ.';return}
  const map=new Map((data.activities||[]).map(a=>[String(a.id),a]));const modified=[];
  let imported=0,duplicate=0,unmatched=0,old=0,noHr=0,failed=0;
  const errors=[];
  byId('heartImportButton').disabled=true;
  try{
    for(let i=0;i<selected.length;i++){
      const file=selected[i],id=file.name.match(/^(\d+)\./)?.[1];
      status.textContent='Zpracovávám '+(i+1)+' / '+selected.length+' souborů…';
      const activity=id?map.get(id):null;
      if(!activity){unmatched++;continue}
      if(activity.date<'2026-05-25'){old++;continue}
      if(activity.heartRate?.points?.length){duplicate++;continue}
      try{
        const raw=await unpack(file);
        const record=/\.json\.gz$/i.test(file.name)?hevyRecords(raw):/\.tcx(?:\.gz)?$/i.test(file.name)?tcxRecords(raw):fitRecords(raw);
        if(record.points.length<2){noHr++;continue}
        modified.push([activity,activity.heartRate]);activity.heartRate=aggregate(record,file.name.toLowerCase().endsWith('json.gz')?'Hevy JSON':/\.tcx(?:\.gz)?$/i.test(file.name)?'Strava TCX':'Strava FIT');
        imported++;
      }catch(e){failed++;if(errors.length<3)errors.push(file.name+': '+e.message)}
      if(i%10===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(imported){
      try{save()}catch(e){for(const [activity,previous] of modified){if(previous===undefined)delete activity.heartRate;else activity.heartRate=previous}status.textContent='Import se nepodařilo uložit: '+e.message+'. Data zůstala beze změny. Zkontroluj volné místo prohlížeče.';return}
    }
    status.textContent='Hotovo: '+imported+' grafů uloženo, '+duplicate+' duplicit, '+unmatched+' bez odpovídající aktivity v CSV, '+old+' starších, '+noHr+' bez tepu, '+failed+' chyb.'+(errors.length?' '+errors.join(' | '):'');
  }finally{byId('heartImportButton').disabled=false}
}
byId('heartImportButton')?.addEventListener('click',()=>{
  const files=[...byId('heartFolder').files,...byId('heartFiles').files];
  importFiles(files).catch(e=>{byId('heartImportStatus').textContent='Chyba importu: '+e.message;byId('heartImportButton').disabled=false});
});
document.dispatchEvent(new Event('radar:data-changed'));
})();