/* RADAR: Strava CSV import. The file is processed locally; no upload to GitHub. */
(function(){
'use strict';
function parseCsv(text){
  text=text.replace(/^\uFEFF/,'');
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++}else if(c==='"')quoted=false;else field+=c}
    else if(c==='"')quoted=true;
    else if(c===','){row.push(field);field=''}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v!==''))rows.push(row);row=[];field=''}
    else field+=c;
  }
  if(quoted)throw Error('CSV obsahuje neuzavřené uvozovky');
  if(field||row.length){row.push(field);rows.push(row)}
  return rows;
}
function n(v){if(v===undefined||v===null||String(v).trim()==='')return null;const x=Number(String(v).replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null}
function day(v){const m=String(v||'').match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);if(m)return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');const iso=String(v||'').match(/^(\d{4}-\d{2}-\d{2})/);return iso?iso[1]:null}
function parseActivities(text){
  const rows=parseCsv(text);if(rows.length<2)throw Error('CSV je prázdné');
  const header=rows.shift().map(x=>x.trim());
  function get(row,cs,en,occ=0){
    for(const name of [cs,en]){
      if(!name)continue;
      const hits=header.map((x,i)=>x===name?i:-1).filter(i=>i>=0);
      if(hits.length>occ)return row[hits[occ]]||'';
    }
    return '';
  }
  const required=[['ID aktivity','Activity ID'],['Datum aktivity','Activity Date'],['Název aktivity','Activity Name'],['Typ aktivity','Activity Type']];
  if(required.some(([cs,en])=>!header.includes(cs)&&!header.includes(en)))throw Error('Soubor nemá požadované sloupce Strava');
  const out=[];let skipped=0;let beforeDiet=0;
  for(const row of rows){
    const id=get(row,'ID aktivity','Activity ID').trim(),date=day(get(row,'Datum aktivity','Activity Date'));
    if(!id||!date){skipped++;continue}if(date<'2026-05-25'){beforeDiet++;continue}
    const distanceMeters=n(get(row,'Vzdálenost','Distance',1));
    const distanceKm=n(get(row,'Vzdálenost','Distance',0));
    const meters=distanceMeters!==null?distanceMeters:(distanceKm===null?null:distanceKm*1000);
    const elapsed=n(get(row,'Uplynulý čas','Elapsed Time',0));
    const moving=n(get(row,'Aktivní čas','Moving Time'));
    const hr=n(get(row,'Průměrná tepová frekvence','Average Heart Rate'));
    const maxHr=n(get(row,'Maximální tepová frekvence','Max Heart Rate',0));
    out.push({
      id,date,name:get(row,'Název aktivity','Activity Name')||'Aktivita',
      type:get(row,'Typ aktivity','Activity Type')||'Ostatní',
      description:get(row,'Popis aktivity','Activity Description')||'',
      elapsedSeconds:elapsed,movingSeconds:moving,
      distanceMeters:meters,
      avgHeartRate:hr,maxHeartRate:maxHr,
      calories:n(get(row,'Kalorie','Calories')),
      elevationMeters:n(get(row,'Nastoupaná výška','Elevation Gain')),
      sets:n(get(row,'Celkový počet sérií','Total Sets')),
      reps:n(get(row,'Celkový počet opakování','Total Reps')),
      source:'Strava CSV'
    });
  }
  return {out,skipped,beforeDiet};
}
function formatDuration(seconds){
  if(seconds===null||seconds===undefined)return '—';
  const m=Math.round(seconds/60);return m>=60?Math.floor(m/60)+' h '+String(m%60).padStart(2,'0')+' min':m+' min';
}
function renderStrava(){
  const all=(Array.isArray(data.activities)?data.activities:[]).filter(x=>x.date>='2026-05-25');
  const yearSelect=document.getElementById('stravaYear');
  if(!yearSelect)return;
  const selected=yearSelect.value;
  const years=[...new Set(all.map(x=>x.date.slice(0,4)))].sort().reverse();
  yearSelect.innerHTML='<option value="all">Všechny roky</option>'+years.map(y=>'<option value="'+y+'">'+y+'</option>').join('');
  yearSelect.value=years.includes(selected)?selected:'all';
  const filtered=all.filter(x=>yearSelect.value==='all'||x.date.startsWith(yearSelect.value));
  document.getElementById('stravaCount').textContent=String(filtered.length);
  document.getElementById('stravaDistance').textContent=fmt(filtered.reduce((s,x)=>s+(Number(x.distanceMeters)||0),0)/1000)+' km';
  document.getElementById('stravaHours').textContent=fmt(filtered.reduce((s,x)=>s+(Number(x.movingSeconds??x.elapsedSeconds)||0),0)/3600)+' h';
  const types={};for(const a of filtered)types[a.type]=(types[a.type]||0)+1;
  document.getElementById('stravaTypes').textContent=String(Object.keys(types).length);
  document.getElementById('stravaBreakdown').textContent=Object.entries(types).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+': '+v).join(' · ');
  document.getElementById('stravaRows').innerHTML=filtered.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(a=>'<tr>'+
    '<td>'+escapeHtml(a.date)+'</td><td title="'+escapeHtml(a.description||'')+'">'+escapeHtml(a.name)+'</td><td>'+escapeHtml(a.type)+'</td>'+
    '<td>'+formatDuration(a.movingSeconds??a.elapsedSeconds)+'</td>'+
    '<td>'+(a.distanceMeters===null||a.distanceMeters===undefined?'—':fmt(a.distanceMeters/1000,2))+'</td>'+
    '<td>'+(a.avgHeartRate==null?'—':fmt(a.avgHeartRate,0))+'</td>'+
    '<td>'+(a.calories==null?'—':fmt(a.calories,0))+'</td>'+
    '<td><button class="delete" data-strava-del="'+escapeHtml(a.id)+'">Smazat</button></td></tr>').join('');
}
document.getElementById('stravaYear').addEventListener('change',renderStrava);
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.page==='strava')renderStrava()}));
document.getElementById('stravaLoad').addEventListener('click',async()=>{
  const file=document.getElementById('stravaFile').files[0],status=document.getElementById('stravaStatus');
  if(!file){status.textContent='Vyber nejdříve CSV soubor.';return}
  try{
    const parsed=parseActivities(await file.text());
    const existing=new Set(data.activities.map(x=>String(x.id)));
    const seen=new Set();const incoming=parsed.out.filter(x=>{if(seen.has(x.id))return false;seen.add(x.id);return !existing.has(x.id)});
    if(!confirm('Načteno '+parsed.out.length+' aktivit. Nových: '+incoming.length+'. Importovat?'))return;
    data.activities.push(...incoming);
    try{save()}catch(e){data.activities.splice(data.activities.length-incoming.length,incoming.length);throw Error('Úložiště prohlížeče je plné. Exportuj zálohu a zkus import znovu.')}
    renderStrava();
    status.textContent='Hotovo: přidáno '+incoming.length+' aktivit od 25. 5. 2026, přeskočeno '+(parsed.out.length-incoming.length)+' již uložených nebo opakovaných, '+parsed.beforeDiet+' starších aktivit'+(parsed.skipped?', neplatných řádků: '+parsed.skipped:'')+'.';
  }catch(e){status.textContent='Import se nezdařil: '+e.message}
});
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-strava-del]');if(!b)return;
  if(!confirm('Smazat tuto aktivitu ze Stravy z RADARu?'))return;
  data.activities=data.activities.filter(a=>String(a.id)!==b.dataset.stravaDel);
  save();renderStrava();
});
renderStrava();
})();